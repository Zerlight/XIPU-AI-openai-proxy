package bridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type attachmentInput struct {
	ImageURL string
	File     *fileInput
	Param    string
}

type attachment struct {
	Kind string `json:"kind"`
	imageAttachment
}

type attachmentFailure struct {
	Index    int    `json:"index"`
	Total    int    `json:"total"`
	Filename string `json:"filename"`
	Kind     string `json:"kind"`
	param    string
}

type attachmentUploadError struct {
	message string
	index   int
	details *attachmentFailure
}

func (err *attachmentUploadError) Error() string {
	details := err.details
	if details == nil || details.Index != err.index || details.Index < 0 || details.Index >= details.Total || !safeAttachmentName(details.Filename) {
		return err.message
	}
	// Older page adapters include their own label before native metadata is verified.
	legacyPrefix := fmt.Sprintf("Upload %s %d/%d (%q): ", details.Kind, details.Index+1, details.Total, details.Filename)
	message := strings.TrimPrefix(err.message, legacyPrefix)
	return fmt.Sprintf("Attachment %d/%d (%s): %s", details.Index+1, details.Total, details.Filename, message)
}

type fileInput struct {
	Name string `json:"filename"`
	Data string `json:"file_data"`
	URL  string `json:"file_url"`
}

var fileNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._ -]*$`)

func safeAttachmentName(name string) bool {
	return len(name) <= 128 && fileNamePattern.MatchString(name) && !strings.HasSuffix(name, ".") && !strings.HasSuffix(name, " ")
}

func fileMIME(name string) (string, error) {
	if !safeAttachmentName(name) {
		return "", errors.New("File name must be a safe basename of at most 128 ASCII characters")
	}
	switch strings.ToLower(path.Ext(name)) {
	case ".pdf":
		return "application/pdf", nil
	case ".txt":
		return "text/plain", nil
	case ".md", ".markdown":
		return "text/markdown", nil
	case ".csv":
		return "text/csv", nil
	default:
		return "", errors.New("Files must be PDF, TXT, Markdown, or CSV")
	}
}

func parseFileInput(raw json.RawMessage, kind string) (fileInput, error) {
	fields := []string{"type", "filename", "file_data", "file_url"}
	if kind == "file" {
		var wrapper struct {
			File json.RawMessage `json:"file"`
		}
		if err := decodeObject(raw, &wrapper, "type", "file"); err != nil {
			return fileInput{}, err
		}
		raw = wrapper.File
		fields = []string{"filename", "file_data"}
	}
	var file fileInput
	if err := decodeObject(raw, &file, fields...); err != nil {
		return file, err
	}
	var values map[string]json.RawMessage
	json.Unmarshal(raw, &values)
	_, hasData := values["file_data"]
	_, hasURL := values["file_url"]
	if hasData == hasURL || (hasData && file.Data == "") || (hasURL && file.URL == "") {
		return file, errors.New("File requires exactly one nonempty file_data or file_url source")
	}
	if hasURL {
		parsed, err := url.Parse(file.URL)
		if err != nil || validateImageURL(parsed) != nil {
			return file, errors.New("File URL must be public HTTPS without credentials")
		}
		if file.Name == "" {
			file.Name = path.Base(parsed.Path)
		}
	}
	if _, err := fileMIME(file.Name); err != nil {
		return file, err
	}
	return file, nil
}

func validateFile(data []byte, mimeType string) error {
	if len(data) == 0 || len(data) > MaxImageBytes {
		return errors.New("File must contain at most 10 MiB")
	}
	if mimeType == "application/pdf" {
		if len(data) < 8 || !bytes.HasPrefix(data, []byte("%PDF-")) || (data[5] != '1' && data[5] != '2') || data[6] != '.' || data[7] < '0' || data[7] > '9' || !bytes.Contains(data[max(0, len(data)-1024):], []byte("%%EOF")) {
			return errors.New("PDF must contain a version header and end marker")
		}
		return nil
	}
	if !utf8.Valid(data) {
		return errors.New("Text files must use UTF-8")
	}
	for _, char := range data {
		if (char < 32 && char != '\t' && char != '\n' && char != '\r' && char != '\f') || char == 127 {
			return errors.New("Text file contains binary control bytes")
		}
	}
	return nil
}

func resolveFile(ctx context.Context, file fileInput) (imageAttachment, error) {
	client := newImageClient(net.DefaultResolver.LookupNetIP, (&net.Dialer{Timeout: 10 * time.Second}).DialContext)
	defer client.CloseIdleConnections()
	return resolveFileWithClient(ctx, file, client)
}

func resolveFileWithClient(ctx context.Context, file fileInput, client *http.Client) (imageAttachment, error) {
	if err := ctx.Err(); err != nil {
		return imageAttachment{}, err
	}
	mimeType, err := fileMIME(file.Name)
	if err != nil {
		return imageAttachment{}, err
	}
	var data []byte
	if file.URL == "" {
		encoded := file.Data
		if strings.HasPrefix(encoded, "data:") {
			header, body, ok := strings.Cut(encoded[5:], ",")
			if !ok || header != mimeType+";base64" {
				return imageAttachment{}, errors.New("File data URL must use base64 and match its filename MIME type")
			}
			encoded = body
		}
		if len(encoded) > base64.StdEncoding.EncodedLen(MaxImageBytes) {
			return imageAttachment{}, errors.New("File exceeds 10 MiB")
		}
		if strings.ContainsAny(encoded, "\r\n") {
			return imageAttachment{}, errors.New("File data must contain valid base64 without line breaks")
		}
		data, err = base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil {
			return imageAttachment{}, errors.New("File data contains invalid base64")
		}
	} else {
		parsed, parseErr := url.Parse(file.URL)
		if parseErr != nil || validateImageURL(parsed) != nil {
			return imageAttachment{}, errors.New("File URL must be public HTTPS without credentials")
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
		if err != nil {
			return imageAttachment{}, errors.New("Invalid file URL")
		}
		request.Header.Set("Accept", mimeType)
		response, err := client.Do(request)
		if err != nil {
			if ctx.Err() != nil {
				return imageAttachment{}, ctx.Err()
			}
			return imageAttachment{}, errors.New("Could not fetch file from a public HTTPS address")
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return imageAttachment{}, fmt.Errorf("File download returned HTTP %d", response.StatusCode)
		}
		if response.ContentLength > MaxImageBytes {
			return imageAttachment{}, errors.New("File exceeds 10 MiB")
		}
		if header := response.Header.Get("Content-Type"); header != "" {
			claimed, params, err := mime.ParseMediaType(header)
			plainText := strings.HasPrefix(mimeType, "text/") && claimed == "text/plain"
			if err != nil || (claimed != mimeType && claimed != "application/octet-stream" && !plainText) || (params["charset"] != "" && !strings.EqualFold(params["charset"], "utf-8") && !strings.EqualFold(params["charset"], "us-ascii")) {
				return imageAttachment{}, errors.New("File download MIME type or encoding does not match the filename")
			}
		}
		data, err = io.ReadAll(io.LimitReader(response.Body, MaxImageBytes+1))
		if err != nil {
			return imageAttachment{}, errors.New("Could not read file download")
		}
	}
	if err := ctx.Err(); err != nil {
		return imageAttachment{}, err
	}
	if err := validateFile(data, mimeType); err != nil {
		return imageAttachment{}, err
	}
	return imageAttachment{Data: base64.StdEncoding.EncodeToString(data), MIME: mimeType, Name: file.Name}, nil
}

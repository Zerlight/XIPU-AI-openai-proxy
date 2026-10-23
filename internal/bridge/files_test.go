package bridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

const testPDF = "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"

func TestFileDataValidation(t *testing.T) {
	for _, item := range []struct{ name, mime, text string }{
		{"sample.pdf", "application/pdf", testPDF},
		{"sample.txt", "text/plain", "Synthetic inventory\nBolts: 3\n"},
		{"sample.md", "text/markdown", "# Inventory\n数量: 3\n"},
		{"sample.MARKDOWN", "text/markdown", "# Inventory\n数量: 3\n"},
		{"sample.csv", "text/csv", "part,count\nbolt,3\n"},
	} {
		for _, prefix := range []string{"", "data:" + item.mime + ";base64,"} {
			encoded := base64.StdEncoding.EncodeToString([]byte(item.text))
			got, err := resolveFile(context.Background(), fileInput{Name: item.name, Data: prefix + encoded})
			if err != nil || got.MIME != item.mime || got.Name != item.name || got.Data != encoded {
				t.Fatalf("file was not preserved: %+v %v", got, err)
			}
		}
	}
	for _, file := range []fileInput{
		{Name: "../sample.txt", Data: "QQ=="}, {Name: "nested/sample.txt", Data: "QQ=="}, {Name: `nested\sample.txt`, Data: "QQ=="},
		{Name: ".sample.txt", Data: "QQ=="}, {Name: "sample.txt ", Data: "QQ=="}, {Name: "sample.txt.", Data: "QQ=="},
		{Name: "sample\n.txt", Data: "QQ=="}, {Name: strings.Repeat("a", 125) + ".txt", Data: "QQ=="},
		{Name: "sample.docx", Data: "QQ=="}, {Name: "sample.txt", Data: "???"}, {Name: "sample.txt", Data: ""},
		{Name: "sample.txt", Data: "QQ==\n"}, {Name: "sample.txt", Data: "AB=="},
		{Name: "sample.txt", Data: "data:application/pdf;base64,QQ=="}, {Name: "sample.txt", Data: "data:text/plain,QQ=="},
		{Name: "sample.txt", Data: base64.StdEncoding.EncodeToString([]byte{0xff, 0xff})},
		{Name: "sample.txt", Data: base64.StdEncoding.EncodeToString([]byte{'A', 0, 'B'})},
		{Name: "sample.txt", Data: base64.StdEncoding.EncodeToString([]byte{'A', 27, 'B'})},
		{Name: "sample.pdf", Data: base64.StdEncoding.EncodeToString([]byte("plain text"))},
		{Name: "sample.pdf", Data: base64.StdEncoding.EncodeToString([]byte("%PDF-1.4\nincomplete"))},
		{Name: "sample.pdf", Data: base64.StdEncoding.EncodeToString([]byte("%PDF-x.4\n%%EOF"))},
		{Name: "sample.txt", Data: strings.Repeat("A", base64.StdEncoding.EncodedLen(MaxImageBytes)+4)},
	} {
		if _, err := resolveFile(context.Background(), file); err == nil {
			t.Fatalf("accepted invalid %q (%d encoded bytes)", file.Name, len(file.Data))
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := resolveFile(ctx, fileInput{Name: "sample.txt", Data: "QQ=="}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation ignored: %v", err)
	}
}

func TestFilePartsRejectAmbiguousAndUnsupportedSources(t *testing.T) {
	for _, raw := range []string{
		`{"type":"input_file","file_id":"file-example"}`,
		`{"type":"input_file","filename":"sample.txt","file_data":"QQ==","file_id":null}`,
		`{"type":"input_file","filename":"sample.txt","file_data":"QQ==","file_url":"https://files.example/sample.txt"}`,
		`{"type":"input_file","filename":"sample.txt","file_data":"QQ==","file_url":null}`,
		`{"type":"input_file","filename":"sample.txt","file_data":null}`,
		`{"type":"input_file","filename":"sample.txt","file_data":23}`,
		`{"type":"input_file","filename":"sample.txt","file_data":""}`,
		`{"type":"input_file","file_data":"QQ=="}`,
		`{"type":"input_file","file_url":"file:///tmp/sample.txt"}`,
		`{"type":"input_file","file_url":"http://files.example/sample.txt"}`,
		`{"type":"input_file","file_url":"https://127.0.0.1/sample.txt"}`,
		`{"type":"input_file","file_url":"https://user:secret@files.example/sample.txt"}`,
		`{"type":"input_file","file_url":"https://files.example/download"}`,
		`{"type":"input_file","file_url":"https://files.example/a%5Cb.txt"}`,
		`{"type":"input_file","filename":"sample.txt","file_data":"QQ==","text":"ignored"}`,
		`{"type":"file","file":{"filename":"sample.txt","file_data":"QQ=="},"file_data":"QQ=="}`,
		`{"type":"file","file":{"filename":"sample.txt","file_data":"QQ==","file_id":"file-example"}}`,
		`{"type":"file","file":{"file_url":"https://files.example/sample.txt"}}`,
	} {
		if _, err := contentText(json.RawMessage("[" + raw + "]")); err == nil {
			t.Fatalf("accepted unsupported file source: %s", raw)
		}
	}
	file, err := parseFileInput(json.RawMessage(`{"type":"input_file","file_url":"https://files.example/sample.csv?download=1"}`), "input_file")
	if err != nil || file.Name != "sample.csv" {
		t.Fatalf("URL basename was not inferred: %+v %v", file, err)
	}
}

func TestFilesRetainOrderAndSurviveHistoricalImageOmission(t *testing.T) {
	content := json.RawMessage(`[{"type":"input_image","image_url":"https://images.example/old.png"},{"type":"input_file","filename":"sample.txt","file_data":"QQ=="}]`)
	messages := []message{{Role: "user", Content: content}, historyText("assistant", "Existing description"), historyText("user", "Continue")}
	text, inputs, err := renderTranscript(messages, true, maxAttachments)
	if err != nil || len(inputs) != 1 || inputs[0].File == nil || !strings.Contains(text, omittedImageText) || !strings.Contains(text, "[File 1: sample.txt]") {
		t.Fatalf("document was omitted with historical image: %v %v", inputs, err)
	}
	_, inputs, err = renderTranscript(messages, false, maxAttachments)
	if err != nil || len(inputs) != 2 || inputs[0].ImageURL == "" || inputs[1].File == nil {
		t.Fatalf("mixed source order lost: %v %v", inputs, err)
	}
	parts := []string{`{"type":"input_image","image_url":"https://images.example/current.png"}`}
	for range maxAttachments - 1 {
		parts = append(parts, `{"type":"input_file","filename":"sample.txt","file_data":"QQ=="}`)
	}
	if _, err := contentText(json.RawMessage("[" + strings.Join(parts, ",") + "]")); err != nil {
		t.Fatalf("mixed attachments at the limit were rejected: %v", err)
	}
	parts = append(parts, `{"type":"input_file","filename":"extra.txt","file_data":"Qg=="}`)
	if _, err := contentText(json.RawMessage("[" + strings.Join(parts, ",") + "]")); err == nil {
		t.Fatal("mixed attachments bypassed the retained attachment limit")
	}
}

func TestFilePayloadInChatAndResponses(t *testing.T) {
	for _, endpoint := range []string{"/v1/chat/completions", "/v1/responses"} {
		t.Run(endpoint, func(t *testing.T) {
			sent := make(chan map[string]any, 2)
			s := New(Options{Key: "synthetic-local-key", Settings: config.Defaults().Settings, Send: func(value any) error { sent <- value.(map[string]any); return nil }})
			t.Cleanup(s.Close)
			s.Receive(map[string]json.RawMessage{"type": json.RawMessage(`"status"`), "tabs": json.RawMessage(`1`)})
			file := map[string]string{"filename": "sample.pdf", "file_data": base64.StdEncoding.EncodeToString([]byte(testPDF))}
			filePart := map[string]any{"type": "file", "file": file}
			if endpoint == "/v1/responses" {
				filePart = map[string]any{"type": "input_file", "filename": file["filename"], "file_data": file["file_data"]}
			}
			parts := []any{map[string]string{"type": "input_image", "image_url": imageDataURL("image/png", testRaster(t, "png"))}}
			for range 9 {
				parts = append(parts, filePart)
			}
			content, _ := json.Marshal(parts)
			body := map[string]any{"model": "synthetic-model", "messages": []message{{Role: "user", Content: content}}}
			if endpoint == "/v1/responses" {
				body["input"] = body["messages"]
				delete(body, "messages")
			}
			raw, _ := json.Marshal(body)
			pending := recordedRequest(s, endpoint, string(raw))
			job := take(t, sent)
			payload := job["payload"].(map[string]any)
			got := payload["attachments"].([]attachment)
			if _, exists := payload["images"]; exists || len(got) != 10 || got[0].Kind != "image" || got[1].Kind != "file" || got[9].Kind != "file" || got[1].Data != file["file_data"] || got[1].MIME != "application/pdf" {
				t.Fatal("mixed attachment payload lost order or duplicated image content")
			}
			wire, _ := json.Marshal(got[1])
			var fields map[string]json.RawMessage
			json.Unmarshal(wire, &fields)
			if len(fields) != 4 || fields["data"] == nil || fields["mime"] == nil || fields["name"] == nil || fields["kind"] == nil {
				t.Fatalf("unexpected attachment wire fields: %s", wire)
			}
			completeText(t, s, job, "Answer")
			if result := <-pending; result.Code != 200 {
				t.Fatalf("request failed: %s", result.Body)
			}
			content, _ = json.Marshal(append(parts, filePart))
			inputField := "messages"
			if endpoint == "/v1/responses" {
				inputField = "input"
			}
			body[inputField] = []message{{Role: "user", Content: content}}
			raw, _ = json.Marshal(body)
			if result := <-recordedRequest(s, endpoint, string(raw)); result.Code != 400 || !strings.Contains(result.Body.String(), "At most 10 attachments") {
				t.Fatalf("eleven attachments were not rejected: %s", result.Body)
			}
			select {
			case <-sent:
				t.Fatal("excess attachments reached the extension")
			default:
			}
		})
	}
}

func TestDocumentCountIsRetainedWhenHistoricalImagesAreOmitted(t *testing.T) {
	parts := []any{map[string]string{"type": "input_image", "image_url": "https://images.example/old.png"}}
	file := map[string]string{"type": "input_file", "filename": "sample.txt", "file_data": "QQ=="}
	for range 10 {
		parts = append(parts, file)
	}
	content, _ := json.Marshal(parts)
	messages := []message{{Role: "user", Content: content}, historyText("assistant", "Existing description"), historyText("user", "Continue")}
	if _, _, err := renderTranscript(messages, false, maxAttachments); err == nil {
		t.Fatal("eleven retained attachments bypassed the count limit")
	}
	if _, inputs, err := renderTranscript(messages, true, maxAttachments); err != nil || len(inputs) != 10 {
		t.Fatalf("omitted image consumed the attachment budget: count=%d error=%v", len(inputs), err)
	}
	messages[0].Content, _ = json.Marshal(append(parts, file))
	if _, _, err := renderTranscript(messages, true, maxAttachments); err == nil {
		t.Fatal("historical documents were omitted from the attachment count")
	}
}

func TestFileDownloadsUseBoundedCredentialFreeTransport(t *testing.T) {
	client := newImageClient(nil, nil)
	for _, item := range []struct {
		url, contentType, text string
		status                 int
		length                 int64
		valid                  bool
	}{
		{"https://files.example/sample.txt", "text/plain; charset=utf-8", "sample", 200, 6, true},
		{"https://files.example/sample.txt", "application/octet-stream", "sample", 200, -1, true},
		{"https://files.example/sample.txt", "text/html", "sample", 200, 6, false},
		{"https://files.example/sample.txt", "text/plain; charset=latin1", "sample", 200, 6, false},
		{"https://files.example/sample.txt", "text/plain", "sample", 404, 6, false},
		{"https://files.example/sample.txt", "text/plain", "sample", 200, MaxImageBytes + 1, false},
		{"https://files.example/sample.txt", "text/plain", strings.Repeat("a", MaxImageBytes+1), 200, -1, false},
		{"https://files.example/sample.txt", "text/plain", "", 200, 0, false},
		{"https://files.example/sample.txt", "text/plain", "\xff", 200, 1, false},
		{"http://files.example/sample.txt", "text/plain", "sample", 200, 6, false},
		{"https://127.0.0.1/sample.txt", "text/plain", "sample", 200, 6, false},
	} {
		client.Transport = imageRoundTrip(func(request *http.Request) (*http.Response, error) {
			if request.Header.Get("Authorization") != "" || request.Header.Get("Jm-Token") != "" || request.Header.Get("Cookie") != "" || request.Header.Get("Referer") != "" || request.Header.Get("Accept") != "text/plain" {
				t.Fatal("download leaked credentials or omitted its media type")
			}
			return &http.Response{StatusCode: item.status, Header: http.Header{"Content-Type": []string{item.contentType}}, ContentLength: item.length, Body: io.NopCloser(strings.NewReader(item.text)), Request: request}, nil
		})
		_, err := resolveFileWithClient(context.Background(), fileInput{Name: "sample.txt", URL: item.url}, client)
		if (err == nil) != item.valid {
			t.Fatalf("unexpected download status for %s %s: %v", item.url, item.contentType, err)
		}
	}
}

func TestFileDownloadRejectsRedirectToPrivateAddress(t *testing.T) {
	client := newImageClient(nil, nil)
	calls := 0
	client.Transport = imageRoundTrip(func(request *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": []string{"https://169.254.169.254/sample.txt"}}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
	})
	_, err := resolveFileWithClient(context.Background(), fileInput{Name: "sample.txt", URL: "https://files.example/sample.txt"}, client)
	if err == nil || calls != 1 {
		t.Fatalf("file download followed an unsafe redirect: calls=%d error=%v", calls, err)
	}
}

func TestCombinedFileBudgetRejectsBeforeNativeDispatch(t *testing.T) {
	sent := make(chan map[string]any, 1)
	s := New(Options{Key: "synthetic-local-key", Settings: config.Defaults().Settings, Send: func(value any) error { sent <- value.(map[string]any); return nil }})
	t.Cleanup(s.Close)
	s.Receive(map[string]json.RawMessage{"type": json.RawMessage(`"status"`), "tabs": json.RawMessage(`1`)})
	data := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 8<<20)))
	part := map[string]string{"type": "input_file", "filename": "sample.txt", "file_data": data}
	content, _ := json.Marshal([]any{part, part, map[string]string{"type": "input_file", "filename": "extra.txt", "file_data": "YQ=="}})
	body, _ := json.Marshal(map[string]any{"model": "synthetic-model", "input": []message{{Role: "user", Content: content}}})
	result := <-recordedRequest(s, "/v1/responses", string(body))
	if result.Code != 400 || !strings.Contains(result.Body.String(), "16 MiB") {
		t.Fatalf("combined attachment limit was not enforced: %s", result.Body)
	}
	select {
	case <-sent:
		t.Fatal("oversized attachment payload reached the extension")
	default:
	}
}

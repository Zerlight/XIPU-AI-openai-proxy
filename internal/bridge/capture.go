package bridge

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

const maxCaptureEventBytes = 32 << 20

type captureContextKey struct{}

type requestCapture struct {
	StartedAt            time.Time         `json:"started_at"`
	FinishedAt           time.Time         `json:"finished_at"`
	Endpoint             string            `json:"endpoint"`
	RequestBody          string            `json:"request_body"`
	RequestBodyTruncated bool              `json:"request_body_truncated,omitempty"`
	SchoolRequest        json.RawMessage   `json:"school_request,omitempty"`
	SchoolEvents         []json.RawMessage `json:"school_events,omitempty"`
	EventsTruncated      bool              `json:"events_truncated,omitempty"`
	Status               int               `json:"http_status"`
	Error                string            `json:"error,omitempty"`
	eventBytes           int
}

func captureFrom(ctx context.Context) *requestCapture {
	capture, _ := ctx.Value(captureContextKey{}).(*requestCapture)
	return capture
}

func (capture *requestCapture) addEvent(event Event) {
	if capture.EventsTruncated {
		return
	}
	raw, err := json.Marshal(event)
	if err != nil || len(raw) > maxCaptureEventBytes-capture.eventBytes {
		capture.EventsTruncated = true
		return
	}
	capture.SchoolEvents = append(capture.SchoolEvents, raw)
	capture.eventBytes += len(raw)
}

func (capture *requestCapture) save(configDir string) {
	// Only body and derived data enter this record; HTTP headers and keys never do.
	if err := capture.write(configDir); err != nil {
		log.Print("Could not save the local request debug capture")
	}
}

func (capture *requestCapture) write(configDir string) error {
	if configDir == "" {
		return os.ErrNotExist
	}
	dir := filepath.Join(configDir, "debug")
	info, err := os.Lstat(dir)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
		return os.ErrInvalid
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return err
	}
	data, err := json.Marshal(capture)
	if err != nil {
		return err
	}
	return config.AtomicWrite(filepath.Join(dir, "latest.json"), append(data, '\n'), 0600)
}

type captureWriter struct {
	http.ResponseWriter
	capture *requestCapture
}

func (writer *captureWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func (writer *captureWriter) WriteHeader(status int) {
	if writer.capture.Status == 0 {
		writer.capture.Status = status
	}
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *captureWriter) Write(data []byte) (int, error) {
	if writer.capture.Status == 0 {
		writer.capture.Status = http.StatusOK
	}
	n, err := writer.ResponseWriter.Write(data)
	if err != nil {
		writer.capture.Error = err.Error()
	}
	return n, err
}

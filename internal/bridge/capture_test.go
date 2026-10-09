package bridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

func readCapture(t *testing.T, dir string) requestCapture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "debug", "latest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "synthetic-secret-header") || strings.Contains(string(raw), "synthetic-local-key") {
		t.Fatal("capture contains request credentials")
	}
	var capture requestCapture
	if err := json.Unmarshal(raw, &capture); err != nil {
		t.Fatal(err)
	}
	return capture
}

func TestCaptureBodyPayloadEventsAndPrivateReplacement(t *testing.T) {
	for _, endpoint := range []string{"/v1/chat/completions", "/v1/responses"} {
		t.Run(endpoint, func(t *testing.T) {
			dir := t.TempDir()
			settings := config.Defaults().Settings
			settings.DebugCaptureRequests = true
			settings.DebugWebSession = true
			settings.DefaultModel = "synthetic-model"
			sent := make(chan map[string]any, 8)
			s := New(Options{Key: "synthetic-local-key", Settings: settings, ConfigDir: dir, Send: func(value any) error { sent <- value.(map[string]any); return nil }})
			defer s.Close()
			s.tabs = 1
			body := ` { "messages": [{"role":"user","content":"synthetic prompt"}], "stream":true } `
			if endpoint == "/v1/responses" {
				body = ` { "input":"synthetic prompt", "stream":true } `
			}
			incoming := httptest.NewRequest(http.MethodPost, "http://127.0.0.1"+endpoint, strings.NewReader(body))
			incoming.Header.Set("Authorization", "Bearer synthetic-local-key")
			incoming.Header.Set("Cookie", "synthetic-secret-header")
			incoming.Header.Set("JmToken", "synthetic-secret-header")
			writer := httptest.NewRecorder()
			done := make(chan struct{})
			go func() { s.ServeHTTP(writer, incoming); close(done) }()
			t.Cleanup(func() { s.Close(); <-done })
			native := take(t, sent)
			initial := readCapture(t, dir)
			if initial.RequestBody != body || initial.Endpoint != endpoint || !initial.FinishedAt.IsZero() {
				t.Fatal("initial capture did not retain the full body and endpoint")
			}
			var payload map[string]any
			if json.Unmarshal(initial.SchoolRequest, &payload) != nil || payload["text"] != "synthetic prompt" || payload["debug_web_session"] != true {
				t.Fatal("capture did not retain derived request and web send mode")
			}
			emit(t, s, native["job"].(string), "event", map[string]any{"type": "string", "data": "synthetic answer"})
			emit(t, s, native["job"].(string), "done", nil)
			<-done
			final := readCapture(t, dir)
			if len(final.SchoolEvents) != 2 || final.FinishedAt.IsZero() || final.Error != "" || final.Status != 200 {
				t.Fatal("completed capture is missing events or completion status")
			}
			if runtime.GOOS != "windows" {
				for path, mode := range map[string]os.FileMode{filepath.Join(dir, "debug"): 0700, filepath.Join(dir, "debug", "latest.json"): 0600} {
					info, err := os.Stat(path)
					if err != nil || info.Mode().Perm() != mode {
						t.Fatal("capture permissions are not private")
					}
				}
			}
			invalid := httptest.NewRequest(http.MethodPost, "http://127.0.0.1"+endpoint, strings.NewReader(`{"unsupported":true}`))
			invalid.Header.Set("Authorization", "Bearer synthetic-local-key")
			s.ServeHTTP(httptest.NewRecorder(), invalid)
			replaced := readCapture(t, dir)
			entries, err := os.ReadDir(filepath.Join(dir, "debug"))
			if err != nil || len(entries) != 1 || replaced.Status != 400 || replaced.Error == "" || len(replaced.SchoolEvents) != 0 || replaced.RequestBody != `{"unsupported":true}` {
				t.Fatal("new capture did not replace the previous request")
			}
		})
	}
}

func TestCaptureRequiresOptInAndAuthentication(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		for _, authorized := range []bool{false, true} {
			dir := t.TempDir()
			settings := config.Defaults().Settings
			settings.DebugCaptureRequests = enabled
			s := New(Options{Key: "synthetic-local-key", Settings: settings, ConfigDir: dir})
			incoming := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/v1/chat/completions", strings.NewReader(`{}`))
			if authorized {
				incoming.Header.Set("Authorization", "Bearer synthetic-local-key")
			}
			s.ServeHTTP(httptest.NewRecorder(), incoming)
			_, err := os.Stat(filepath.Join(dir, "debug", "latest.json"))
			if (err == nil) != (enabled && authorized) {
				t.Fatal("capture did not honor opt-in and authentication")
			}
		}
	}
}

func TestCaptureActiveCompletionReplacesConcurrentBusyCapture(t *testing.T) {
	dir := t.TempDir()
	settings := config.Defaults().Settings
	settings.DebugCaptureRequests = true
	settings.DefaultModel = "synthetic-model"
	sent := make(chan map[string]any, 8)
	s := New(Options{Key: "synthetic-local-key", Settings: settings, ConfigDir: dir, Send: func(value any) error { sent <- value.(map[string]any); return nil }})
	s.tabs = 1
	makeRequest := func(text string) *http.Request {
		incoming := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/v1/chat/completions", strings.NewReader(`{"messages":[{"role":"user","content":"`+text+`"}]}`))
		incoming.Header.Set("Authorization", "Bearer synthetic-local-key")
		return incoming
	}
	done := make(chan struct{})
	go func() { s.ServeHTTP(httptest.NewRecorder(), makeRequest("synthetic active")); close(done) }()
	t.Cleanup(func() { s.Close(); <-done })
	native := take(t, sent)
	s.ServeHTTP(httptest.NewRecorder(), makeRequest("synthetic busy"))
	if capture := readCapture(t, dir); capture.Status != 503 || !strings.Contains(capture.RequestBody, "synthetic busy") {
		t.Fatal("concurrent busy request was not captured")
	}
	emit(t, s, native["job"].(string), "event", map[string]any{"type": "string", "data": "synthetic answer"})
	emit(t, s, native["job"].(string), "done", nil)
	<-done
	if capture := readCapture(t, dir); capture.Status != 200 || !strings.Contains(capture.RequestBody, "synthetic active") || len(capture.SchoolEvents) != 2 {
		t.Fatal("active completion did not replace the concurrent busy capture")
	}
}

func TestCaptureRecordsCancellationAndLimitsEvents(t *testing.T) {
	capture := &requestCapture{eventBytes: maxCaptureEventBytes - 1}
	capture.addEvent(Event{Kind: "done"})
	if !capture.EventsTruncated || len(capture.SchoolEvents) != 0 {
		t.Fatal("capture did not bound events")
	}
	dir := t.TempDir()
	settings := config.Defaults().Settings
	settings.DebugCaptureRequests = true
	settings.DefaultModel = "synthetic-model"
	sent := make(chan map[string]any, 8)
	s := New(Options{Key: "synthetic-local-key", Settings: settings, ConfigDir: dir, Send: func(value any) error { sent <- value.(map[string]any); return nil }})
	defer s.Close()
	s.tabs = 1
	ctx, cancel := context.WithCancel(context.Background())
	incoming := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/v1/chat/completions", strings.NewReader(`{"messages":[{"role":"user","content":"synthetic"}]}`)).WithContext(ctx)
	incoming.Header.Set("Authorization", "Bearer synthetic-local-key")
	done := make(chan struct{})
	go func() { s.ServeHTTP(httptest.NewRecorder(), incoming); close(done) }()
	take(t, sent)
	cancel()
	<-done
	if final := readCapture(t, dir); final.Error != context.Canceled.Error() {
		t.Fatal("capture omitted cancellation")
	}
	if native := take(t, sent); native["type"] != "cancel" {
		t.Fatal("capture interfered with cancellation")
	}
}

func TestCaptureRefusesSymlinkDirectoryAndFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks require special privileges on Windows")
	}
	for _, linkDir := range []bool{false, true} {
		dir := t.TempDir()
		destination := t.TempDir()
		link := filepath.Join(dir, "debug")
		if !linkDir {
			if err := os.Mkdir(link, 0700); err != nil {
				t.Fatal(err)
			}
			link = filepath.Join(link, "latest.json")
			destination = filepath.Join(destination, "outside.json")
		}
		if err := os.Symlink(destination, link); err != nil {
			t.Fatal(err)
		}
		if err := (&requestCapture{}).write(dir); err == nil {
			t.Fatal("capture followed a symlink")
		}
	}
}

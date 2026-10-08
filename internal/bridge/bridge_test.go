package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

func fixture(t *testing.T, timeout time.Duration) (*Server, *httptest.Server, chan map[string]any) {
	t.Helper()
	sent := make(chan map[string]any, 16)
	settings := config.Defaults().Settings
	settings.SessionName = "Synthetic Session"
	settings.ChatTimeoutSeconds = max(1, int(timeout/time.Second))
	s := New(Options{Key: "synthetic-local-key", Settings: settings, Send: func(value any) error { sent <- value.(map[string]any); return nil }})
	if err := s.Receive(map[string]json.RawMessage{"type": json.RawMessage(`"status"`), "tabs": json.RawMessage(`1`)}); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(s)
	t.Cleanup(func() { s.Close(); httpServer.Close() })
	return s, httpServer, sent
}

func emit(t *testing.T, s *Server, id, kind string, raw any) {
	t.Helper()
	event := map[string]any{"job": id, "kind": kind}
	if kind == "result" {
		event["result"] = raw
	} else if kind == "event" {
		event["event"] = raw
	} else if raw != nil {
		event["message"] = raw
	}
	body, _ := json.Marshal(map[string]any{"type": "evt", "evt": event})
	var value map[string]json.RawMessage
	json.Unmarshal(body, &value)
	if err := s.Receive(value); err != nil {
		t.Fatal(err)
	}
}

type response struct {
	status int
	body   string
	err    error
}

func request(t *testing.T, ctx context.Context, base, path, body, key string) <-chan response {
	t.Helper()
	result := make(chan response, 1)
	go func() {
		method := "GET"
		if body != "" {
			method = "POST"
		}
		r, err := http.NewRequestWithContext(ctx, method, base+path, strings.NewReader(body))
		if err != nil {
			result <- response{err: err}
			return
		}
		if key != "" {
			r.Header.Set("Authorization", "Bearer "+key)
		}
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			result <- response{err: err}
			return
		}
		defer res.Body.Close()
		data, err := io.ReadAll(res.Body)
		result <- response{status: res.StatusCode, body: string(data), err: err}
	}()
	return result
}

func take(t *testing.T, sent <-chan map[string]any) map[string]any {
	t.Helper()
	select {
	case value := <-sent:
		return value
	case <-time.After(3 * time.Second):
		t.Fatal("missing native message")
		return nil
	}
}

func TestAuthenticationHostAndSingleFlight(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	unauthorized := <-request(t, context.Background(), host.URL, "/v1/models", "", "")
	if unauthorized.status != 401 {
		t.Fatalf("unexpected unauthorized response %+v", unauthorized)
	}
	recorder := httptest.NewRecorder()
	incoming := httptest.NewRequest("GET", "http://evil.example/health", nil)
	s.ServeHTTP(recorder, incoming)
	if recorder.Code != 403 {
		t.Fatal("accepted non-loopback Host header")
	}
	first := request(t, context.Background(), host.URL, "/v1/models", "", "synthetic-local-key")
	job := take(t, sent)
	second := <-request(t, context.Background(), host.URL, "/v1/models", "", "synthetic-local-key")
	if second.status != 503 || !strings.Contains(second.body, "bridge_busy") {
		t.Fatalf("unexpected busy response %+v", second)
	}
	emit(t, s, job["job"].(string), "result", map[string]any{"code": 0, "data": map[string]any{"models": []any{map[string]any{"value": "model-a", "label": "Model A", "price": 0}}}})
	emit(t, s, job["job"].(string), "done", nil)
	if result := <-first; result.status != 200 || !strings.Contains(result.body, `"id":"model-a"`) {
		t.Fatalf("bad catalog %+v", result)
	}
	select {
	case unexpected := <-sent:
		t.Fatalf("unexpected request %+v", unexpected)
	default:
	}
}

func TestBufferedChatAndPayload(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	result := request(t, context.Background(), host.URL, "/v1/chat/completions", `{"model":"model-a","messages":[{"role":"system","content":"Rules"},{"role":"user","content":"Hello"}],"reasoning_effort":"high"}`, "synthetic-local-key")
	job := take(t, sent)
	payload := job["payload"].(map[string]any)
	if payload["text"] != "[system]\nRules\n\n[user]\nHello" || payload["session_name"] != "Synthetic Session" || payload["thinking"] != "high" || payload["model"] != "model-a" {
		t.Fatalf("wrong payload %+v", payload)
	}
	emit(t, s, "wrong-job", "event", map[string]any{"type": "string", "data": "MUST_NOT_APPEAR"})
	emit(t, s, job["job"].(string), "event", map[string]any{"code": 0, "type": "string", "data": "Answer", "reasoning_data": "Reason"})
	emit(t, s, job["job"].(string), "event", map[string]any{"code": 0, "type": "object", "data": map[string]any{"aiText": "Answer", "reason": "Reason"}})
	emit(t, s, job["job"].(string), "done", nil)
	got := <-result
	if got.status != 200 || !strings.Contains(got.body, `"content":"Answer"`) || !strings.Contains(got.body, `"reasoning_content":"Reason"`) || strings.Contains(got.body, "MUST_NOT_APPEAR") {
		t.Fatalf("bad completion %+v", got)
	}
}

func TestStreamingErrorIsStructuredAndDoesNotClaimStop(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	result := request(t, context.Background(), host.URL, "/v1/chat/completions", `{"model":"model-a","messages":[{"role":"user","content":"Hello"}],"stream":true}`, "synthetic-local-key")
	job := take(t, sent)
	emit(t, s, job["job"].(string), "event", map[string]any{"type": "string", "data": "Partial"})
	emit(t, s, job["job"].(string), "event", map[string]any{"code": 10006, "data": "Rate limited"})
	got := <-result
	if got.status != 200 || !strings.Contains(got.body, "event: error\n") || !strings.Contains(got.body, `"error":`) || !strings.Contains(got.body, "[DONE]") || strings.Contains(got.body, `"finish_reason":"stop"`) {
		t.Fatalf("wrong streaming error %+v", got)
	}
	if cancel := take(t, sent); cancel["type"] != "cancel" || cancel["job"] != job["job"] {
		t.Fatalf("missing cancellation %+v", cancel)
	}
	select {
	case unexpected := <-sent:
		t.Fatalf("request was retried %+v", unexpected)
	default:
	}
}

func TestSuccessfulStreamEscapesEventLikeContent(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	result := request(t, context.Background(), host.URL, "/v1/chat/completions", `{"model":"model-a","messages":[{"role":"user","content":"Hello"}],"stream":true}`, "synthetic-local-key")
	job := take(t, sent)
	text := "Answer\n\ndata: [DONE]\n\nevent: error"
	emit(t, s, job["job"].(string), "event", map[string]any{"type": "string", "data": text})
	emit(t, s, job["job"].(string), "done", nil)
	got := <-result
	if got.status != 200 || strings.Count(got.body, "\ndata: [DONE]\n") != 1 || strings.Contains(got.body, "\nevent: error\n") || !strings.Contains(got.body, `"finish_reason":"stop"`) {
		t.Fatalf("bad SSE framing %+v", got)
	}
	var content strings.Builder
	for _, line := range strings.Split(got.body, "\n") {
		if !strings.HasPrefix(line, "data: {") {
			continue
		}
		var frame struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &frame); err != nil {
			t.Fatal(err)
		}
		content.WriteString(frame.Choices[0].Delta.Content)
	}
	if content.String() != text {
		t.Fatalf("stream content changed: %q", content.String())
	}
}

func TestTimeoutAndClientCancellation(t *testing.T) {
	for _, clientCancel := range []bool{false, true} {
		t.Run(map[bool]string{false: "timeout", true: "client disconnect"}[clientCancel], func(t *testing.T) {
			_, host, sent := fixture(t, 30*time.Millisecond)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := request(t, ctx, host.URL, "/v1/chat/completions", `{"model":"model-a","messages":[{"role":"user","content":"Hello"}]}`, "synthetic-local-key")
			job := take(t, sent)
			if clientCancel {
				cancel()
			}
			got := <-result
			if !clientCancel && (got.status != 504 || !strings.Contains(got.body, "timed out")) {
				t.Fatalf("wrong timeout response %+v", got)
			}
			if cancellation := take(t, sent); cancellation["type"] != "cancel" || cancellation["job"] != job["job"] {
				t.Fatal("request was not cancelled")
			}
		})
	}
}

func TestUnsupportedTemperatureAndOversizedRequestNeverReachExtension(t *testing.T) {
	_, host, sent := fixture(t, time.Second)
	for _, body := range []string{`{"model":"model-a","messages":[{"content":"Hello"}],"temperature":0}`, `{"model":"model-a","messages":[{"content":"Hello"}],"tools":[{}]}`} {
		if got := <-request(t, context.Background(), host.URL, "/v1/chat/completions", body, "synthetic-local-key"); got.status != 400 {
			t.Fatalf("unsupported request accepted %+v", got)
		}
	}
	large := bytes.Repeat([]byte("x"), 1<<20)
	if got := <-request(t, context.Background(), host.URL, "/v1/chat/completions", string(large), "synthetic-local-key"); got.status != 400 {
		t.Fatalf("oversized body accepted %+v", got)
	}
	select {
	case unexpected := <-sent:
		t.Fatalf("request was sent %+v", unexpected)
	default:
	}
}

func TestOnlineValuesAndMissingText(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	for _, online := range []string{"true", "false", "0", "1"} {
		result := request(t, context.Background(), host.URL, "/v1/chat/completions", `{"model":"model-a","messages":[{"content":"Hello"}],"online":`+online+`}`, "synthetic-local-key")
		job := take(t, sent)
		want := 0
		if online == "true" || online == "1" {
			want = 1
		}
		if job["payload"].(map[string]any)["online"] != want {
			t.Fatalf("wrong online mapping for %s", online)
		}
		emit(t, s, job["job"].(string), "event", map[string]any{"type": "object", "data": map[string]any{"sessionId": 42}})
		emit(t, s, job["job"].(string), "done", nil)
		if got := <-result; got.status != 502 || !strings.Contains(got.body, "missing_result") {
			t.Fatalf("accepted metadata-only completion %+v", got)
		}
	}
	for _, online := range []string{`"true"`, "2", "-1", "{}", "[]"} {
		got := <-request(t, context.Background(), host.URL, "/v1/chat/completions", `{"model":"model-a","messages":[{"content":"Hello"}],"online":`+online+`}`, "synthetic-local-key")
		if got.status != 400 {
			t.Fatalf("accepted invalid online %s", online)
		}
	}
	select {
	case unexpected := <-sent:
		t.Fatalf("invalid request was sent %+v", unexpected)
	default:
	}
	health := <-request(t, context.Background(), host.URL, "/health", "", "")
	if health.status != 200 || strings.Contains(health.body, "session") || strings.Contains(health.body, "key") {
		t.Fatalf("health exposed private configuration %+v", health)
	}
}

func TestConfiguredDefaultsExplicitOverridesAndHiddenReasoning(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	settings := config.Defaults().Settings
	settings.SessionName = "Configured Session"
	settings.DefaultModel = "configured-model"
	settings.Thinking = "high"
	settings.Online = true
	settings.IncludeReasoning = false
	if err := s.UpdateSettings(settings, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	for _, stream := range []bool{false, true} {
		body, _ := json.Marshal(map[string]any{"messages": []any{map[string]any{"role": "user", "content": "Hello"}}, "stream": stream})
		result := request(t, context.Background(), host.URL, "/v1/chat/completions", string(body), "synthetic-local-key")
		job := take(t, sent)
		payload := job["payload"].(map[string]any)
		if payload["model"] != "configured-model" || payload["thinking"] != "high" || payload["online"] != 1 || payload["session_name"] != "Configured Session" {
			t.Fatalf("defaults were not applied: %+v", payload)
		}
		emit(t, s, job["job"].(string), "event", map[string]any{"type": "string", "reasoning_data": "SYNTHETIC_REASONING_MUST_BE_HIDDEN"})
		emit(t, s, job["job"].(string), "done", nil)
		got := <-result
		if got.status != 502 || !strings.Contains(got.body, "missing_result") || strings.Contains(got.body, "reasoning_content") || strings.Contains(got.body, "SYNTHETIC_REASONING") {
			t.Fatalf("reason-only response filtering failed: %+v", got)
		}
	}
	result := request(t, context.Background(), host.URL, "/v1/chat/completions", `{"model":"explicit-model","messages":[{"content":"Hello"}],"reasoning_effort":"low","online":false}`, "synthetic-local-key")
	job := take(t, sent)
	payload := job["payload"].(map[string]any)
	if payload["model"] != "explicit-model" || payload["thinking"] != "low" || payload["online"] != 0 {
		t.Fatalf("request did not override defaults: %+v", payload)
	}
	emit(t, s, job["job"].(string), "event", map[string]any{"type": "string", "data": "Answer"})
	emit(t, s, job["job"].(string), "done", nil)
	if got := <-result; got.status != 200 || !strings.Contains(got.body, `"model":"explicit-model"`) {
		t.Fatalf("wrong selected model %+v", got)
	}
	for _, path := range []string{"/models", "/chat/completions"} {
		if got := <-request(t, context.Background(), host.URL, path, "", "synthetic-local-key"); got.status != 404 {
			t.Fatal("short compatibility endpoint remains available")
		}
	}
}

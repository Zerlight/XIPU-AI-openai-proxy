package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestCapabilityErrorStatus(t *testing.T) {
	for _, endpoint := range []string{"chat/completions", "responses"} {
		for _, stream := range []bool{false, true} {
			for _, code := range []string{"unsupported_image_model", "debug_web_session_unavailable", "", "unrecognized_error"} {
				t.Run(fmt.Sprintf("%s/stream=%v/code=%s", endpoint, stream, code), func(t *testing.T) {
					s, host, sent := fixture(t, time.Second)
					input := `"messages":[{"role":"user","content":"Hello"}]`
					if endpoint == "responses" {
						input = `"input":"Hello"`
					}
					body := fmt.Sprintf(`{"model":"model-a","stream":%v,%s}`, stream, input)
					result := request(t, context.Background(), host.URL, "/v1/"+endpoint, body, "synthetic-local-key")
					job := take(t, sent)
					event := Event{Job: job["job"].(string), Kind: "done", Code: code, Message: "The model does not advertise image support."}
					if code == "debug_web_session_unavailable" {
						event.Message = "Open the configured conversation before using webpage send flow."
					}
					raw, err := json.Marshal(event)
					if err != nil {
						t.Fatal(err)
					}
					if err := s.Receive(map[string]json.RawMessage{"type": json.RawMessage(`"evt"`), "evt": raw}); err != nil {
						t.Fatal(err)
					}
					got := <-result
					wantStatus, wantCode, wantType := 502, "upstream_error", "bridge_error"
					if code == "unsupported_image_model" || code == "debug_web_session_unavailable" {
						wantStatus, wantCode, wantType = 400, code, "invalid_request_error"
					}
					var response struct {
						Error struct{ Code, Type, Message string } `json:"error"`
					}
					if err := json.Unmarshal([]byte(got.body), &response); err != nil {
						t.Fatalf("expected JSON error before SSE: %s", got.body)
					}
					if got.status != wantStatus || response.Error.Code != wantCode || response.Error.Type != wantType || response.Error.Message != event.Message {
						t.Fatalf("wrong capability error: %+v", got)
					}
					select {
					case retry := <-sent:
						t.Fatalf("capability error was retried: %+v", retry)
					default:
					}
					health := <-request(t, context.Background(), host.URL, "/health", "", "")
					if !strings.Contains(health.body, `"busy":false`) {
						t.Fatalf("capability error left bridge busy: %s", health.body)
					}
				})
			}
		}
	}
}

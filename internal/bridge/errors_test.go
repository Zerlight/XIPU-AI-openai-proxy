package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func sendFailure(t *testing.T, s *Server, job map[string]any, fields map[string]any) {
	t.Helper()
	fields["job"], fields["kind"], fields["message"] = job["job"], "done", "School operation failed"
	raw, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Receive(map[string]json.RawMessage{"type": json.RawMessage(`"evt"`), "evt": raw}); err != nil {
		t.Fatal(err)
	}
}

func TestSchoolErrorsPreserveSafeMetadata(t *testing.T) {
	for _, item := range []struct {
		code, stage string
		http, want  int
	}{
		{"school_auth_required", "authentication", 401, 502},
		{"school_rate_limited", "generation", 429, 429},
		{"school_rate_limited", "generation", 200, 502},
		{"school_http_error", "generation", 403, 502},
		{"school_rejected", "generation", 200, 502},
		{"school_invalid_response", "generation", 200, 502},
		{"school_network_error", "generation", 0, 502},
		{"school_stream_incomplete", "stream", 200, 502},
		{"school_stream_error", "stream", 200, 502},
		{"school_session_not_found", "session_read", 200, 400},
		{"school_session_ambiguous", "session_read", 200, 400},
		{"school_session_unsafe", "session_read", 200, 400},
		{"school_session_update_failed", "session_update", 200, 502},
		{"school_model_unavailable", "model_catalog", 200, 400},
		{"bridge_busy", "connection", 0, 503},
		{"tab_unavailable", "connection", 0, 503},
		{"school_tab_disconnected", "connection", 0, 503},
		{"native_request_invalid", "connection", 0, 502},
		{"native_request_timeout", "connection", 0, 504},
	} {
		for _, endpoint := range []string{"chat/completions", "responses", "models"} {
			for _, stream := range []bool{false, true} {
				if endpoint == "models" && stream {
					continue
				}
				t.Run(fmt.Sprintf("%s/%s/%d/stream=%v", item.code, endpoint, item.http, stream), func(t *testing.T) {
					s, host, sent := fixture(t, time.Second)
					input := `"messages":[{"role":"user","content":"Hello"}]`
					if endpoint == "responses" {
						input = `"input":"Hello"`
					}
					body := fmt.Sprintf(`{"model":"synthetic-model","stream":%v,%s}`, stream, input)
					if endpoint == "models" {
						body = ""
					}
					pending := request(t, context.Background(), host.URL, "/v1/"+endpoint, body, "synthetic-local-key")
					job := take(t, sent)
					sendFailure(t, s, job, map[string]any{"code": item.code, "stage": item.stage, "http_status": item.http, "school_code": 10008, "param": "untrusted.path", "body": "untrusted body"})
					got := <-pending
					var result struct {
						Error map[string]any `json:"error"`
					}
					if err := json.Unmarshal([]byte(got.body), &result); err != nil {
						t.Fatalf("expected JSON before SSE: %v", err)
					}
					failure := result.Error
					wantType := "bridge_error"
					if item.want == 400 {
						wantType = "invalid_request_error"
					}
					if item.want == 429 {
						wantType = "rate_limit_error"
					}
					if got.status != item.want || failure["code"] != item.code || failure["type"] != wantType || failure["stage"] != item.stage {
						t.Fatalf("unexpected school error: %d %s", got.status, got.body)
					}
					upstream := failure["upstream"].(map[string]any)
					if upstream["school_code"] != float64(10008) || (item.http != 0 && upstream["http_status"] != float64(item.http)) || (item.http == 0 && upstream["http_status"] != nil) {
						t.Fatalf("numeric upstream metadata changed: %+v", upstream)
					}
					if item.code == "school_model_unavailable" {
						if failure["param"] != "model" {
							t.Fatal("model error omitted parameter")
						}
					} else if failure["param"] != nil {
						t.Fatal("accepted page-supplied parameter")
					}
					if strings.Contains(got.body, "untrusted") {
						t.Fatal("untrusted metadata was exposed")
					}
					select {
					case <-sent:
						t.Fatal("school error was retried")
					default:
					}
				})
			}
		}
	}
}

func TestSchoolErrorMetadataValidation(t *testing.T) {
	for _, invalid := range []any{nil, "429", 1.5, true, []any{}, map[string]any{}, -9007199254740992.0, 9007199254740992.0} {
		s, host, sent := fixture(t, time.Second)
		pending := request(t, context.Background(), host.URL, "/v1/models", "", "synthetic-local-key")
		job := take(t, sent)
		sendFailure(t, s, job, map[string]any{"code": "school_rejected", "stage": invalid, "http_status": invalid, "school_code": invalid})
		got := <-pending
		var result struct {
			Error map[string]any `json:"error"`
		}
		json.Unmarshal([]byte(got.body), &result)
		if got.status != 502 || result.Error["code"] != "school_rejected" || result.Error["stage"] != nil || result.Error["upstream"] != nil {
			t.Fatalf("malformed metadata was accepted: %s", got.body)
		}
	}
	for _, code := range []string{"", "unknown_error", "10008"} {
		s, host, sent := fixture(t, time.Second)
		pending := request(t, context.Background(), host.URL, "/v1/models", "", "synthetic-local-key")
		job := take(t, sent)
		sendFailure(t, s, job, map[string]any{"code": code, "stage": "generation", "http_status": 429, "school_code": 10008})
		got := <-pending
		var result struct {
			Error map[string]any `json:"error"`
		}
		json.Unmarshal([]byte(got.body), &result)
		if got.status != 502 || result.Error["code"] != "upstream_error" || result.Error["stage"] != nil || result.Error["upstream"] != nil {
			t.Fatalf("unknown code gained guessed semantics: %s", got.body)
		}
	}
	for _, status := range []int{99, 600} {
		event := Event{Code: "school_rate_limited", HTTPStatus: json.RawMessage(fmt.Sprint(status)), Stage: json.RawMessage(`"private-stage"`)}
		err := schoolFailure(event, fmt.Errorf("Request failed"))
		if code, _ := errorStatus(err); code != 502 || errorDetails(err)["upstream"] != nil || errorDetails(err)["stage"] != nil {
			t.Fatal("out-of-range HTTP status or unknown stage accepted")
		}
	}
}

func TestLocalValidationReportsKnownParameters(t *testing.T) {
	for _, item := range []struct{ endpoint, body, param string }{
		{"chat/completions", `{`, "body"},
		{"chat/completions", `{"messages":[]}`, "messages"},
		{"chat/completions", `{"temperature":0}`, "temperature"},
		{"chat/completions", `{"store":true}`, "store"},
		{"chat/completions", `{"n":2}`, "n"},
		{"chat/completions", `{"stream_options":{"unknown":true}}`, "stream_options"},
		{"chat/completions", `{"tools":[{"type":"unknown"}]}`, "tools"},
		{"chat/completions", `{"tool_choice":"required"}`, "tool_choice"},
		{"chat/completions", `{"response_format":{"type":"unknown"}}`, "response_format"},
		{"chat/completions", `{"max_tokens":0}`, "max_tokens"},
		{"responses", `{"input":42}`, "input"},
		{"responses", `{"store":true}`, "store"},
		{"responses", `{"background":true}`, "background"},
		{"responses", `{"previous_response_id":"resp_example"}`, "previous_response_id"},
		{"responses", `{"include":["unknown"]}`, "include"},
		{"responses", `{"truncation":"auto"}`, "truncation"},
		{"responses", `{"input":"Hello","tools":[{"type":"unknown"}]}`, "tools"},
		{"responses", `{"input":"Hello","tool_choice":"unknown"}`, "tool_choice"},
		{"responses", `{"input":"Hello","text":{"unknown":true}}`, "text"},
		{"responses", `{"input":"Hello","text":{"format":{"type":"unknown"}}}`, "text.format"},
		{"responses", `{"input":"Hello","reasoning":{"summary":"auto"}}`, "reasoning"},
		{"responses", `{"input":"Hello","model":"synthetic-model","online":"yes"}`, "online"},
		{"responses", `{"input":"Hello","model":""}`, "model"},
		{"responses", `{"max_output_tokens":0}`, "max_output_tokens"},
		{"responses", `{"model":"synthetic-model","input":[{"role":"user","content":[{"type":"input_file","filename":"sample.txt","file_data":"/w=="}]}]}`, "input[0].content[0]"},
		{"chat/completions", `{"model":"synthetic-model","messages":[{"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,QQ=="}]}]}`, "messages[0].content[0]"},
	} {
		t.Run(item.endpoint+"/"+item.param, func(t *testing.T) {
			_, host, sent := fixture(t, time.Second)
			got := <-request(t, context.Background(), host.URL, "/v1/"+item.endpoint, item.body, "synthetic-local-key")
			var result struct {
				Error map[string]any `json:"error"`
			}
			json.Unmarshal([]byte(got.body), &result)
			if got.status != 400 || result.Error["param"] != item.param || result.Error["type"] != "invalid_request_error" || result.Error["stage"] != "request_validation" {
				t.Fatalf("wrong local parameter: %d %s", got.status, got.body)
			}
			select {
			case <-sent:
				t.Fatal("invalid request reached the school")
			default:
			}
		})
	}
}

func TestWaitFailuresHaveDistinctCodes(t *testing.T) {
	for _, mode := range []string{"idle", "overall", "disconnect"} {
		t.Run(mode, func(t *testing.T) {
			s, host, sent := fixture(t, time.Second)
			wantCode, wantStage, wantStatus := "native_disconnected", "connection", 502
			if mode == "idle" {
				s.options.Settings.IdleTimeoutSeconds = 0
				wantCode, wantStage, wantStatus = "bridge_idle_timeout", "response_wait", 504
			}
			if mode == "overall" {
				s.options.Settings.ModelTimeoutSeconds = 0
				wantCode, wantStage, wantStatus = "bridge_timeout", "response_wait", 504
			}
			pending := request(t, context.Background(), host.URL, "/v1/models", "", "synthetic-local-key")
			take(t, sent)
			if mode == "disconnect" {
				s.Close()
			}
			got := <-pending
			var result struct {
				Error map[string]any `json:"error"`
			}
			json.Unmarshal([]byte(got.body), &result)
			if got.status != wantStatus || result.Error["code"] != wantCode || result.Error["stage"] != wantStage {
				t.Fatalf("wrong wait failure: %d %s", got.status, got.body)
			}
		})
	}
}

func TestInvalidSchoolPayloadsPreserveClassification(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `{"type":"object","data":"unexpected"}`} {
		var parser parser
		_, err := parser.parse(json.RawMessage(raw))
		if err == nil {
			t.Fatalf("accepted invalid school event %s", raw)
		}
		details := errorDetails(err)
		if status, _ := errorStatus(err); status != 502 || details["code"] != "school_invalid_response" || details["stage"] != "generation" || details["upstream"] != nil {
			t.Fatalf("lost school payload diagnosis: %+v", details)
		}
	}
	for _, raw := range []string{`null`, `{"data":"unexpected"}`} {
		_, err := models(json.RawMessage(raw))
		if err == nil || errorDetails(err)["code"] != "school_invalid_response" || errorDetails(err)["stage"] != "model_catalog" {
			t.Fatalf("lost model catalog diagnosis: %v", err)
		}
	}
}

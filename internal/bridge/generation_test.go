package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

const weatherTool = `{"type":"function","function":{"name":"weather","description":"Read weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false},"strict":true}}`
const weatherEnvelope = `{"content":null,"tool_calls":[{"name":"weather","arguments":{"city":"Suzhou"}}]}`

func completeText(t *testing.T, s *Server, job map[string]any, text string) {
	t.Helper()
	emit(t, s, job["job"].(string), "event", map[string]any{"type": "string", "data": text})
	emit(t, s, job["job"].(string), "done", nil)
}

func TestChatToolsRoundTripPreservesCallIdentity(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	first := request(t, context.Background(), host.URL, "/v1/chat/completions", `{"model":"model-a","messages":[{"role":"user","content":"Weather?"}],"tools":[`+weatherTool+`],"tool_choice":"required"}`, "synthetic-local-key")
	job := take(t, sent)
	if !strings.Contains(job["payload"].(map[string]any)["text"].(string), "Read weather") {
		t.Fatal("Tool description missing from prompt")
	}
	completeText(t, s, job, weatherEnvelope)
	got := <-first
	if got.status != 200 {
		t.Fatalf("tool call failed %+v", got)
	}
	var answer struct {
		Choices []struct {
			Message message `json:"message"`
			Finish  string  `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal([]byte(got.body), &answer); err != nil {
		t.Fatal(err)
	}
	assistant := answer.Choices[0].Message
	if len(assistant.ToolCalls) != 1 || assistant.ToolCalls[0].Function.Arguments != `{"city":"Suzhou"}` || answer.Choices[0].Finish != "tool_calls" {
		t.Fatalf("Bad calls %+v", answer)
	}
	callID := assistant.ToolCalls[0].ID
	body, _ := json.Marshal(map[string]any{"model": "model-a", "messages": []message{{Role: "user", Content: json.RawMessage(`"Weather?"`)}, assistant, {Role: "tool", ToolCallID: callID, Content: json.RawMessage(`"Sunny"`)}}, "tools": []json.RawMessage{json.RawMessage(weatherTool)}})
	second := request(t, context.Background(), host.URL, "/v1/chat/completions", string(body), "synthetic-local-key")
	job = take(t, sent)
	prompt := job["payload"].(map[string]any)["text"].(string)
	if !strings.Contains(prompt, callID) || !strings.Contains(prompt, `"output":"Sunny"`) || !strings.Contains(prompt, `\"city\":\"Suzhou\"`) {
		t.Fatalf("Tool replay lost fields: %s", prompt)
	}
	completeText(t, s, job, `{"content":"It is sunny.","tool_calls":[]}`)
	if got := <-second; got.status != 200 || !strings.Contains(got.body, "It is sunny.") {
		t.Fatalf("Bad final answer %+v", got)
	}
}

func TestToolValidationAndChoiceRejectInvalidGenerations(t *testing.T) {
	cases := []struct {
		name, choice, text string
		parallel           bool
	}{
		{"unknown function", `"auto"`, `{"content":null,"tool_calls":[{"name":"unknown","arguments":{}}]}`, true},
		{"wrong schema", `"auto"`, `{"content":null,"tool_calls":[{"name":"weather","arguments":{"city":4}}]}`, true},
		{"extra argument", `"auto"`, `{"content":null,"tool_calls":[{"name":"weather","arguments":{"city":"A","extra":1}}]}`, true},
		{"required", `"required"`, `{"content":"Answer","tool_calls":[]}`, true},
		{"none", `"none"`, weatherEnvelope, true},
		{"parallel", `"auto"`, `{"content":null,"tool_calls":[{"name":"weather","arguments":{"city":"A"}},{"name":"weather","arguments":{"city":"B"}}]}`, false},
		{"unknown field", `"auto"`, `{"content":null,"tool_calls":[{"name":"weather","arguments":{"city":"A"},"id":"invented"}]}`, true},
		{"duplicate key", `"auto"`, `{"content":"ok","content":null,"tool_calls":[]}`, true},
		{"markdown", `"auto"`, "```json\n" + weatherEnvelope + "\n```", true},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			s, host, sent := fixture(t, time.Second)
			body, _ := json.Marshal(map[string]any{"model": "model-a", "messages": []message{{Role: "user", Content: json.RawMessage(`"Weather?"`)}}, "tools": []json.RawMessage{json.RawMessage(weatherTool)}, "tool_choice": json.RawMessage(item.choice), "parallel_tool_calls": item.parallel, "stream": true})
			pending := request(t, context.Background(), host.URL, "/v1/chat/completions", string(body), "synthetic-local-key")
			job := take(t, sent)
			completeText(t, s, job, item.text)
			got := <-pending
			if got.status != 502 || !strings.Contains(got.body, "invalid_generation") || strings.Contains(got.body, "chat.completion.chunk") {
				t.Fatalf("Invalid output escaped buffered validation %+v", got)
			}
			select {
			case retry := <-sent:
				t.Fatalf("Unexpected retry %+v", retry)
			default:
			}
		})
	}
}

func TestForcedToolNamedAutoIsNotAutomaticChoice(t *testing.T) {
	raw := json.RawMessage(`{"type":"function","function":{"name":"auto","parameters":{"type":"object"}}}`)
	tools, err := parseTools([]json.RawMessage{raw}, json.RawMessage(`{"type":"function","function":{"name":"auto"}}`), nil, false)
	if err != nil {
		t.Fatal(err)
	}
	req := generationRequest{tools: tools, format: outputFormat{kind: "text"}}
	if _, err := req.validate(`{"content":"no call","tool_calls":[]}`, "", "test"); !errors.Is(err, errInvalidGeneration) {
		t.Fatal("Forced function named auto was treated as automatic")
	}
}

func TestValidatedToolStreamContainsCallsAndTerminalReason(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	pending := request(t, context.Background(), host.URL, "/v1/chat/completions", `{"model":"model-a","messages":[{"content":"Weather?"}],"tools":[`+weatherTool+`],"stream":true}`, "synthetic-local-key")
	job := take(t, sent)
	completeText(t, s, job, weatherEnvelope)
	got := <-pending
	if got.status != 200 || !strings.Contains(got.body, `"finish_reason":"tool_calls"`) || !strings.Contains(got.body, `"index":0,"type":"function"`) || strings.Contains(got.body, `"content":null`) {
		t.Fatalf("Wrong tool stream %+v", got)
	}
}

func TestStructuredOutputsValidateBeforeStreaming(t *testing.T) {
	cases := []struct {
		name, format, output string
		status               int
	}{
		{"json object", `{"type":"json_object"}`, `{"ok":true}`, 200},
		{"object rejects array", `{"type":"json_object"}`, `[]`, 502},
		{"schema with local ref", `{"type":"json_schema","json_schema":{"name":"answer","strict":true,"schema":{"$defs":{"answer":{"type":"integer","minimum":2}},"type":"object","properties":{"answer":{"$ref":"#/$defs/answer"}},"required":["answer"],"additionalProperties":false}}}`, `{"answer":42}`, 200},
		{"schema rejects string", `{"type":"json_schema","json_schema":{"name":"answer","schema":{"type":"integer"}}}`, `"42"`, 502},
		{"duplicate output", `{"type":"json_object"}`, `{"x":1,"x":2}`, 502},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			s, host, sent := fixture(t, time.Second)
			pending := request(t, context.Background(), host.URL, "/v1/chat/completions", `{"model":"model-a","messages":[{"content":"Answer"}],"response_format":`+item.format+`,"stream":true}`, "synthetic-local-key")
			job := take(t, sent)
			completeText(t, s, job, item.output)
			got := <-pending
			if got.status != item.status {
				t.Fatalf("Wrong validation result %+v", got)
			}
			if item.status == 502 && strings.Contains(got.body, "chat.completion.chunk") {
				t.Fatal("Unvalidated JSON streamed")
			}
		})
	}
}

func TestSchemaNetworkAccessAndUnsupportedSemanticsRejectedBeforeSchool(t *testing.T) {
	_, host, sent := fixture(t, time.Second)
	invalid := []string{
		`{"response_format":{"type":"json_schema","json_schema":{"name":"bad","schema":{"$ref":"https://example.com/schema"}}}}`,
		`{"response_format":{"type":"json_schema","json_schema":{"name":"bad","schema":{"$schema":"https://example.com/schema"}}}}`,
		`{"response_format":{"type":"json_schema","json_schema":{"name":"bad","schema":{"$ref":"file:///etc/passwd"}}}}`,
		`{"tools":[{"type":"web_search"}]}`, `{"n":2}`,
	}
	for _, fields := range invalid {
		body := `{"model":"model-a","messages":[{"content":"Hello"}],` + fields[1:]
		got := <-request(t, context.Background(), host.URL, "/v1/chat/completions", body, "synthetic-local-key")
		if got.status != 400 {
			t.Fatalf("Unsupported request accepted %+v", got)
		}
	}
	select {
	case job := <-sent:
		t.Fatalf("Invalid request reached school %+v", job)
	default:
	}
}

func recordedRequest(s *Server, path, body string) <-chan *httptest.ResponseRecorder {
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		recorder := httptest.NewRecorder()
		incoming := httptest.NewRequest("POST", "http://127.0.0.1"+path, strings.NewReader(body))
		incoming.Header.Set("Authorization", "Bearer synthetic-local-key")
		s.ServeHTTP(recorder, incoming)
		result <- recorder
	}()
	return result
}

func chatChunks(t *testing.T, body string) []map[string]any {
	t.Helper()
	var chunks []map[string]any
	for _, line := range strings.Split(body, "\n") {
		if !strings.HasPrefix(line, "data: ") || line == "data: [DONE]" {
			continue
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &chunk); err != nil {
			t.Fatal(err)
		}
		if chunk["object"] == "chat.completion.chunk" {
			chunks = append(chunks, chunk)
		}
	}
	return chunks
}

func TestChatRequestedUsageRemainsUnknown(t *testing.T) {
	for _, mode := range []string{"text", "tools", "truncated", "nonstream"} {
		t.Run(mode, func(t *testing.T) {
			s, _, sent := fixture(t, time.Second)
			fields := `"stream":true`
			if mode == "nonstream" {
				fields = `"stream":false`
			} else if mode == "tools" {
				fields += `,"tools":[` + weatherTool + `]`
			}
			pending := recordedRequest(s, "/v1/chat/completions", `{"model":"model-a","messages":[{"content":"Hello"}],"stream_options":{"include_usage":true},`+fields+`}`)
			job := take(t, sent)
			switch mode {
			case "tools":
				completeText(t, s, job, weatherEnvelope)
			case "truncated":
				emit(t, s, job["job"].(string), "event", map[string]any{"type": "string", "data": "Partial"})
				emit(t, s, job["job"].(string), "done", "The school stream ended before its completion marker")
			default:
				emit(t, s, job["job"].(string), "event", map[string]any{"type": "string", "reasoning_data": "Reason"})
				completeText(t, s, job, "Answer")
			}
			got := <-pending
			if got.Code != 200 || got.Header().Get("X-XIPU-Usage") != "unavailable" {
				t.Fatalf("Usage compatibility failed: %d %v %s", got.Code, got.Header(), got.Body)
			}
			if mode == "nonstream" {
				var body map[string]any
				json.Unmarshal(got.Body.Bytes(), &body)
				if value, ok := body["usage"]; !ok || value != nil {
					t.Fatalf("Expected unknown usage: %s", got.Body)
				}
			} else {
				chunks := chatChunks(t, got.Body.String())
				if len(chunks) < 2 || strings.Count(got.Body.String(), "data: [DONE]\n") != 1 {
					t.Fatalf("Invalid stream termination: %s", got.Body)
				}
				for _, chunk := range chunks {
					if value, ok := chunk["usage"]; !ok || value != nil || len(chunk["choices"].([]any)) != 1 {
						t.Fatalf("Fabricated or omitted usage: %+v", chunk)
					}
				}
				last := chunks[len(chunks)-1]["choices"].([]any)[0].(map[string]any)
				want := any("stop")
				if mode == "tools" {
					want = "tool_calls"
				} else if mode == "truncated" {
					want = nil
					if !strings.Contains(got.Body.String(), "event: error\n") {
						t.Fatal("Truncated stream lost its error")
					}
				}
				if last["finish_reason"] != want {
					t.Fatalf("Changed finish reason: %+v", last)
				}
			}
			select {
			case extra := <-sent:
				t.Fatalf("Usage reporting caused another school request: %+v", extra)
			default:
			}
		})
	}
}

func TestChatUsageOptionsValidation(t *testing.T) {
	for _, options := range []string{`null`, `{}`, `{"include_usage":null}`, `{"include_usage":false}`} {
		s, _, sent := fixture(t, time.Second)
		pending := recordedRequest(s, "/v1/chat/completions", `{"model":"model-a","messages":[{"content":"Hello"}],"stream":true,"stream_options":`+options+`}`)
		completeText(t, s, take(t, sent), "Answer")
		got := <-pending
		if got.Code != 200 || got.Header().Get("X-XIPU-Usage") != "" || strings.Contains(got.Body.String(), `"usage"`) {
			t.Fatalf("Unrequested usage changed stream: %s %s", options, got.Body)
		}
	}
	s, _, sent := fixture(t, time.Second)
	for _, options := range []string{`[]`, `true`, `"true"`, `{"unknown":false}`, `{"include_usage":1}`, `{"include_usage":"true"}`, `{"include_usage":[]}`, `{"include_usage":{}}`, `{"include_usage":true,"include_usage":false}`} {
		got := <-recordedRequest(s, "/v1/chat/completions", `{"model":"model-a","messages":[{"content":"Hello"}],"stream":true,"stream_options":`+options+`}`)
		if got.Code != 400 {
			t.Fatalf("Invalid options accepted: %s %s", options, got.Body)
		}
	}
	select {
	case extra := <-sent:
		t.Fatalf("Invalid options reached school: %+v", extra)
	default:
	}
}

func TestChatTokenLimitsAreValidatedCompatibilityFields(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, limits := range []struct{ fields, ignored string }{
			{`"max_tokens":null,"max_completion_tokens":null`, ""},
			{`"max_tokens":1`, "max_tokens"},
			{`"max_completion_tokens":9223372036854775807`, "max_completion_tokens"},
			{`"max_tokens":1,"max_completion_tokens":1`, "max_tokens, max_completion_tokens"},
		} {
			s, _, sent := fixture(t, time.Second)
			body := `{"model":"model-a","messages":[{"content":"Hello"}],"stream":false,` + limits.fields + `}`
			if stream {
				body = strings.Replace(body, `"stream":false`, `"stream":true`, 1)
			}
			pending := recordedRequest(s, "/v1/chat/completions", body)
			job := take(t, sent)
			assertTokenLimitsNotForwarded(t, job)
			completeText(t, s, job, "An answer longer than the requested one-token hint")
			got := <-pending
			if got.Code != 200 || got.Header().Get("X-XIPU-Ignored-Parameters") != limits.ignored || !strings.Contains(got.Body.String(), "An answer longer") || strings.Contains(got.Body.String(), `"finish_reason":"length"`) {
				t.Fatalf("Compatibility token limit changed result: %v %s", got.Header(), got.Body)
			}
		}
	}
	s, _, sent := fixture(t, time.Second)
	for _, name := range []string{"max_tokens", "max_completion_tokens"} {
		for _, value := range []string{`0`, `-1`, `1.5`, `1.0`, `true`, `"1"`, `[]`, `{}`, `9223372036854775808`} {
			got := <-recordedRequest(s, "/v1/chat/completions", `{"model":"model-a","messages":[{"content":"Hello"}],"`+name+`":`+value+`}`)
			if got.Code != 400 {
				t.Fatalf("Invalid token limit accepted: %s=%s", name, value)
			}
		}
	}
	got := <-recordedRequest(s, "/v1/chat/completions", `{"model":"model-a","messages":[{"content":"Hello"}],"max_tokens":1,"max_completion_tokens":2}`)
	if got.Code != 400 {
		t.Fatal("Conflicting token limits accepted")
	}
	select {
	case extra := <-sent:
		t.Fatalf("Invalid token limit reached school: %+v", extra)
	default:
	}
}

func assertTokenLimitsNotForwarded(t *testing.T, job map[string]any) {
	t.Helper()
	payload := job["payload"].(map[string]any)
	if payload["text"] != "Hello" {
		t.Fatalf("Token limit modified prompt: %+v", payload)
	}
	for _, name := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
		if _, ok := payload[name]; ok {
			t.Fatalf("Token limit forwarded to school: %s", name)
		}
	}
}

func TestToolHistoryRequiresMatchingUnambiguousResults(t *testing.T) {
	call := toolCall{ID: "call_synthetic", Type: "function", Function: functionCall{Name: "weather", Arguments: `{"city":"A"}`}}
	cases := [][]message{
		{{Role: "tool", ToolCallID: "unknown", Content: json.RawMessage(`"answer"`)}},
		{{Role: "assistant", ToolCalls: []toolCall{call}}},
		{{Role: "assistant", ToolCalls: []toolCall{call}}, {Role: "tool", ToolCallID: call.ID, Content: json.RawMessage(`"answer"`)}, {Role: "tool", ToolCallID: call.ID, Content: json.RawMessage(`"again"`)}},
		{{Role: "assistant", ToolCalls: []toolCall{call, call}}, {Role: "tool", ToolCallID: call.ID, Content: json.RawMessage(`"answer"`)}},
	}
	for _, messages := range cases {
		if _, _, err := buildTranscript(messages); err == nil {
			t.Fatalf("Accepted ambiguous history %+v", messages)
		}
	}
	var item message
	if json.Unmarshal([]byte(`{"role":"assistant","function_call":{"name":"lost","arguments":"{}"}}`), &item) == nil {
		t.Fatal("Deprecated function_call silently ignored")
	}
}

func TestPreparationReservesSlotWithoutHoldingMutex(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	entered := make(chan struct{})
	unblock := make(chan struct{})
	finished := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	incoming := httptest.NewRequest("POST", "http://127.0.0.1/v1/chat/completions", nil).WithContext(ctx)
	incoming.Header.Set("Authorization", "Bearer synthetic-local-key")
	go func() {
		defer close(finished)
		s.start(httptest.NewRecorder(), incoming, "chat", func(config.Settings) (any, error) {
			close(entered)
			<-unblock
			return nil, errors.New("Synthetic preparation failure")
		})
	}()
	<-entered
	healthContext, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	health := <-request(t, healthContext, host.URL, "/health", "", "")
	if health.err != nil || !strings.Contains(health.body, `"busy":true`) {
		close(unblock)
		t.Fatalf("Preparation blocked health: %+v", health)
	}
	if err := s.UpdateSettings(config.Defaults().Settings, func() error { t.Fatal("Busy mutation persisted"); return nil }); err == nil {
		t.Fatal("Busy settings accepted")
	}
	cancel()
	close(unblock)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("Preparation did not release")
	}
	if health := <-request(t, context.Background(), host.URL, "/health", "", ""); !strings.Contains(health.body, `"busy":false`) {
		t.Fatal("Preparation left slot busy")
	}
	select {
	case job := <-sent:
		t.Fatalf("Failed preparation reached school %+v", job)
	default:
	}
}

func TestFailedNativeSendCancelsPartialTransfer(t *testing.T) {
	sent := []map[string]any{}
	server := New(Options{Key: "synthetic-local-key", Settings: config.Defaults().Settings, Send: func(value any) error {
		item := value.(map[string]any)
		sent = append(sent, item)
		if item["type"] == "req" {
			return errors.New("Synthetic partial transfer failure")
		}
		return nil
	}})
	defer server.Close()
	server.Receive(map[string]json.RawMessage{"type": json.RawMessage(`"status"`), "tabs": json.RawMessage(`1`)})
	incoming := httptest.NewRequest("GET", "http://127.0.0.1/v1/models", nil)
	incoming.Header.Set("Authorization", "Bearer synthetic-local-key")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, incoming)
	if recorder.Code != 502 || len(sent) != 2 || sent[1]["type"] != "cancel" || sent[0]["job"] != sent[1]["job"] {
		t.Fatalf("Partial request was not cancelled: %d %+v", recorder.Code, sent)
	}
	if server.current != nil {
		t.Fatal("Failed request retained the slot")
	}
}

func TestPathologicalJSONNumbersRejectedBeforeSchemaEvaluation(t *testing.T) {
	for _, number := range []string{"1e10000000", "-1e-10000000", strings.Repeat("1", 1025)} {
		if _, err := exactJSON([]byte(number)); err == nil {
			t.Fatalf("Unbounded number accepted: %.30s", number)
		}
	}
	if _, err := exactJSON([]byte(`{"n":1e1000,"m":1e-1000}`)); err != nil {
		t.Fatal("Bounded exact numbers rejected", err)
	}
	_, host, sent := fixture(t, time.Second)
	body := `{"model":"model-a","messages":[{"content":"Answer"}],"response_format":{"type":"json_schema","json_schema":{"name":"answer","schema":{"type":"number","minimum":1e10000000}}}}`
	got := <-request(t, context.Background(), host.URL, "/v1/chat/completions", body, "synthetic-local-key")
	if got.status != 400 {
		t.Fatalf("Pathological schema reached validation %+v", got)
	}
	select {
	case job := <-sent:
		t.Fatalf("Rejected number reached school %+v", job)
	default:
	}
}

func TestGeneratedPathologicalNumberFailsWithoutLosingRequestSlot(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	body := `{"model":"model-a","messages":[{"content":"Answer"}],"response_format":{"type":"json_schema","json_schema":{"name":"answer","schema":{"type":"integer","minimum":0}}}}`
	pending := request(t, context.Background(), host.URL, "/v1/chat/completions", body, "synthetic-local-key")
	job := take(t, sent)
	completeText(t, s, job, "1e10000000")
	if got := <-pending; got.status != 502 || !strings.Contains(got.body, "invalid_generation") {
		t.Fatalf("Unbounded generated number accepted %+v", got)
	}
	health := <-request(t, context.Background(), host.URL, "/health", "", "")
	if !strings.Contains(health.body, `"busy":false`) {
		t.Fatal("Invalid generated number leaked request slot")
	}
}

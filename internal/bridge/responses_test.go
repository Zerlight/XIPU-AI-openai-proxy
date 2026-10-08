package bridge

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const responsesWeatherTool = `{"type":"function","name":"weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false},"strict":true}`

func responseEvents(t *testing.T, text string) []map[string]any {
	t.Helper()
	events := []map[string]any{}
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
			t.Fatal(err)
		}
		if event["sequence_number"] != float64(len(events)) {
			t.Fatalf("Nonsequential event %+v", event)
		}
		events = append(events, event)
	}
	return events
}
func findResponseEvent(events []map[string]any, kind string) map[string]any {
	for _, event := range events {
		if event["type"] == kind {
			return event
		}
	}
	return nil
}

func TestResponsesTextStreamHasConsistentItemIdentityAndReplay(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	pending := request(t, context.Background(), host.URL, "/v1/responses", `{"model":"model-a","instructions":"Be concise","input":"Hello","stream":true,"store":false}`, "synthetic-local-key")
	job := take(t, sent)
	if job["payload"].(map[string]any)["text"] != "[developer]\nBe concise\n\n[user]\nHello" {
		t.Fatal("Instructions lost")
	}
	emit(t, s, job["job"].(string), "event", map[string]any{"type": "string", "data": "An", "reasoning_data": "PRIVATE_RAW_REASONING"})
	completeText(t, s, job, "swer")
	got := <-pending
	if got.status != 200 || strings.Contains(got.body, "PRIVATE_RAW_REASONING") || strings.Contains(got.body, "[DONE]") {
		t.Fatalf("Invalid Responses stream %+v", got)
	}
	events := responseEvents(t, got.body)
	first := findResponseEvent(events, "response.created")
	completed := findResponseEvent(events, "response.completed")
	if first == nil || completed == nil {
		t.Fatal("Missing lifecycle events")
	}
	response := completed["response"].(map[string]any)
	if response["id"] != first["response"].(map[string]any)["id"] || response["store"] != false || response["usage"] != nil {
		t.Fatal("Response metadata mismatch")
	}
	output := response["output"].([]any)
	item := output[0].(map[string]any)
	for _, event := range events {
		if id, ok := event["item_id"]; ok && id != item["id"] {
			t.Fatal("Inconsistent item ID")
		}
	}
	if item["content"].([]any)[0].(map[string]any)["text"] != "Answer" {
		t.Fatal("Final text did not reconstruct deltas")
	}
	replay, _ := json.Marshal(map[string]any{"model": "model-a", "input": []any{map[string]any{"role": "user", "content": "Hello"}, item, map[string]any{"role": "user", "content": "Continue"}}})
	pending = request(t, context.Background(), host.URL, "/v1/responses", string(replay), "synthetic-local-key")
	job = take(t, sent)
	if !strings.Contains(job["payload"].(map[string]any)["text"].(string), "[assistant]\nAnswer") {
		t.Fatal("Assistant output replay lost text")
	}
	completeText(t, s, job, "Continued")
	if got := <-pending; got.status != 200 {
		t.Fatalf("Replay failed %+v", got)
	}
}

func TestResponsesFunctionStreamAndStatelessToolResultRoundTrip(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	pending := request(t, context.Background(), host.URL, "/v1/responses", `{"model":"model-a","input":"Weather?","tools":[`+responsesWeatherTool+`],"tool_choice":{"type":"function","name":"weather"},"stream":true}`, "synthetic-local-key")
	job := take(t, sent)
	completeText(t, s, job, weatherEnvelope)
	got := <-pending
	if got.status != 200 {
		t.Fatalf("Tool stream failed %+v", got)
	}
	events := responseEvents(t, got.body)
	delta := findResponseEvent(events, "response.function_call_arguments.delta")
	done := findResponseEvent(events, "response.function_call_arguments.done")
	completed := findResponseEvent(events, "response.completed")
	if delta == nil || done == nil || completed == nil || delta["delta"] != done["arguments"] {
		t.Fatal("Missing or inconsistent argument events")
	}
	output := completed["response"].(map[string]any)["output"].([]any)
	call := output[0].(map[string]any)
	if call["id"] != delta["item_id"] || call["arguments"] != `{"city":"Suzhou"}` {
		t.Fatal("Function call identity changed")
	}
	replay, _ := json.Marshal(map[string]any{"model": "model-a", "input": []any{map[string]any{"role": "user", "content": "Weather?"}, call, map[string]any{"type": "function_call_output", "call_id": call["call_id"], "output": "Sunny"}}, "tools": []json.RawMessage{json.RawMessage(responsesWeatherTool)}})
	pending = request(t, context.Background(), host.URL, "/v1/responses", string(replay), "synthetic-local-key")
	job = take(t, sent)
	prompt := job["payload"].(map[string]any)["text"].(string)
	if !strings.Contains(prompt, call["call_id"].(string)) || !strings.Contains(prompt, "Sunny") {
		t.Fatal("Call ID or result lost")
	}
	completeText(t, s, job, `{"content":"Sunny today.","tool_calls":[]}`)
	if got := <-pending; got.status != 200 || !strings.Contains(got.body, "Sunny today.") {
		t.Fatalf("Tool replay failed %+v", got)
	}
}

func TestResponsesSchemaFailureAndUpstreamFailureNeverComplete(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	pending := request(t, context.Background(), host.URL, "/v1/responses", `{"model":"model-a","input":"Answer","stream":true,"text":{"format":{"type":"json_schema","name":"answer","strict":true,"schema":{"type":"object","required":["answer"]}}}}`, "synthetic-local-key")
	job := take(t, sent)
	completeText(t, s, job, `{"wrong":42}`)
	if got := <-pending; got.status != 502 || strings.Contains(got.body, "response.completed") {
		t.Fatalf("Invalid schema completed %+v", got)
	}
	pending = request(t, context.Background(), host.URL, "/v1/responses", `{"model":"model-a","input":"Answer","stream":true}`, "synthetic-local-key")
	job = take(t, sent)
	emit(t, s, job["job"].(string), "event", map[string]any{"type": "string", "data": "Partial"})
	emit(t, s, job["job"].(string), "error", "Synthetic school error")
	got := <-pending
	events := responseEvents(t, got.body)
	if got.status != 200 || findResponseEvent(events, "response.failed") == nil || findResponseEvent(events, "response.completed") != nil || findResponseEvent(events, "response.output_text.done") != nil {
		t.Fatalf("Failure claimed completion %+v", got)
	}
}

func TestResponsesRejectStateHostedToolsAndEmptyVisibleOutput(t *testing.T) {
	s, host, sent := fixture(t, time.Second)
	for _, fields := range []string{`"store":true`, `"previous_response_id":"resp_old"`, `"background":true`, `"include":["reasoning.encrypted_content"]`, `"conversation":"conv_old"`, `"tools":[{"type":"web_search"}]`, `"reasoning":{"summary":"auto"}`, `"input":[{"type":"function_call_output","call_id":"unknown","output":"x"}]`} {
		prefix := `{"model":"model-a","input":"Hello",`
		if strings.HasPrefix(fields, `"input"`) {
			prefix = `{"model":"model-a",`
		}
		got := <-request(t, context.Background(), host.URL, "/v1/responses", prefix+fields+`}`, "synthetic-local-key")
		if got.status != 400 {
			t.Fatalf("Unsupported semantics accepted %+v", got)
		}
	}
	select {
	case job := <-sent:
		t.Fatalf("Rejected request reached school %+v", job)
	default:
	}
	pending := request(t, context.Background(), host.URL, "/v1/responses", `{"model":"model-a","input":"Hello","stream":true}`, "synthetic-local-key")
	job := take(t, sent)
	emit(t, s, job["job"].(string), "event", map[string]any{"type": "string", "reasoning_data": "Only reasoning"})
	emit(t, s, job["job"].(string), "done", nil)
	if got := <-pending; got.status != 502 || !strings.Contains(got.body, "missing_result") {
		t.Fatalf("Empty visible output accepted %+v", got)
	}
}

func TestResponsesTokenLimitIsAValidatedCompatibilityField(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, value := range []string{`null`, `1`, `9223372036854775807`} {
			s, _, sent := fixture(t, time.Second)
			body := `{"model":"model-a","input":"Hello","max_output_tokens":` + value + `,"stream":false}`
			if stream {
				body = strings.Replace(body, `"stream":false`, `"stream":true`, 1)
			}
			pending := recordedRequest(s, "/v1/responses", body)
			job := take(t, sent)
			assertTokenLimitsNotForwarded(t, job)
			completeText(t, s, job, "An answer longer than the requested one-token hint")
			got := <-pending
			ignored := "max_output_tokens"
			if value == "null" {
				ignored = ""
			}
			if got.Code != 200 || got.Header().Get("X-XIPU-Ignored-Parameters") != ignored || !strings.Contains(got.Body.String(), "An answer longer") {
				t.Fatalf("Compatibility token limit changed result: %v %s", got.Header(), got.Body)
			}
			var response map[string]any
			if stream {
				completed := findResponseEvent(responseEvents(t, got.Body.String()), "response.completed")
				if completed == nil {
					t.Fatal("Missing completed response")
				}
				response = completed["response"].(map[string]any)
			} else if err := json.Unmarshal(got.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if response["status"] != "completed" || response["incomplete_details"] != nil || response["usage"] != nil {
				t.Fatalf("Invented token-limit semantics: %+v", response)
			}
		}
	}
	s, _, sent := fixture(t, time.Second)
	for _, value := range []string{`0`, `-1`, `1.5`, `1.0`, `true`, `"1"`, `[]`, `{}`, `9223372036854775808`} {
		got := <-recordedRequest(s, "/v1/responses", `{"model":"model-a","input":"Hello","max_output_tokens":`+value+`}`)
		if got.Code != 400 {
			t.Fatalf("Invalid token limit accepted: %s", value)
		}
	}
	select {
	case extra := <-sent:
		t.Fatalf("Invalid token limit reached school: %+v", extra)
	default:
	}
}

func TestSchemaPropertyNamesAreNotSchemaKeywords(t *testing.T) {
	schema, err := compileSchema(json.RawMessage(`{"$id":"https://example.invalid/embedded.json","type":"object","properties":{"$ref":{"type":"string"},"$id":{"const":"instance-id"}},"required":["$ref","$id"]}`))
	if err != nil {
		t.Fatal(err)
	}
	value, _ := exactJSON([]byte(`{"$ref":"literal-value","$id":"instance-id"}`))
	if err := schema.Validate(value); err != nil {
		t.Fatal(err)
	}
}

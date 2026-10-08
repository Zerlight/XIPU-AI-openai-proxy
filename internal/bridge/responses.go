package bridge

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type responsesRequest struct {
	Model        *string           `json:"model"`
	Input        json.RawMessage   `json:"input"`
	Instructions string            `json:"instructions"`
	Stream       bool              `json:"stream"`
	Store        *bool             `json:"store"`
	Background   bool              `json:"background"`
	Previous     json.RawMessage   `json:"previous_response_id"`
	Tools        []json.RawMessage `json:"tools"`
	ToolChoice   json.RawMessage   `json:"tool_choice"`
	Parallel     *bool             `json:"parallel_tool_calls"`
	Text         json.RawMessage   `json:"text"`
	Reasoning    json.RawMessage   `json:"reasoning"`
	Online       json.RawMessage   `json:"online"`
	Include      []string          `json:"include"`
	Truncation   string            `json:"truncation"`
	MaxOutput    *int64            `json:"max_output_tokens"`
}

func responseMessages(input json.RawMessage, instructions string) ([]message, error) {
	messages := []message{}
	if instructions != "" {
		raw, _ := json.Marshal(instructions)
		messages = append(messages, message{Role: "developer", Content: raw})
	}
	var text string
	if json.Unmarshal(input, &text) == nil {
		messages = append(messages, message{Role: "user", Content: input})
		return messages, nil
	}
	var items []json.RawMessage
	if json.Unmarshal(input, &items) != nil || len(items) == 0 {
		return nil, errors.New("Input must be text or a nonempty array of messages and function items")
	}
	for _, raw := range items {
		var item struct {
			Type      string          `json:"type"`
			Role      string          `json:"role"`
			Content   json.RawMessage `json:"content"`
			ID        string          `json:"id"`
			Status    string          `json:"status"`
			Name      string          `json:"name"`
			Arguments string          `json:"arguments"`
			CallID    string          `json:"call_id"`
			Output    json.RawMessage `json:"output"`
		}
		if err := json.Unmarshal(raw, &item); err != nil {
			return nil, errors.New("Invalid input item")
		}
		switch item.Type {
		case "", "message":
			if err := decodeObject(raw, &item, "type", "role", "content", "id", "status"); err != nil {
				return nil, err
			}
			if item.Role != "user" && item.Role != "assistant" && item.Role != "system" && item.Role != "developer" {
				return nil, errors.New("Unsupported input message role")
			}
			messages = append(messages, message{Role: item.Role, Content: item.Content})
		case "function_call":
			if err := decodeObject(raw, &item, "type", "id", "status", "name", "arguments", "call_id"); err != nil {
				return nil, err
			}
			call := toolCall{ID: item.CallID, Type: "function", Function: functionCall{Name: item.Name, Arguments: item.Arguments}}
			if len(messages) > 0 && messages[len(messages)-1].Role == "assistant" && len(messages[len(messages)-1].ToolCalls) > 0 {
				messages[len(messages)-1].ToolCalls = append(messages[len(messages)-1].ToolCalls, call)
			} else {
				messages = append(messages, message{Role: "assistant", ToolCalls: []toolCall{call}})
			}
		case "function_call_output":
			if err := decodeObject(raw, &item, "type", "id", "status", "call_id", "output"); err != nil {
				return nil, err
			}
			if len(item.Output) == 0 {
				return nil, errors.New("Function output is required")
			}
			messages = append(messages, message{Role: "tool", ToolCallID: item.CallID, Content: item.Output})
		default:
			return nil, errors.New("Unsupported Responses input item type")
		}
	}
	return messages, nil
}
func (s *Server) responses(w http.ResponseWriter, r *http.Request) {
	var body responsesRequest
	if err := readRequest(w, r, &body, "model", "input", "instructions", "stream", "store", "background", "previous_response_id", "tools", "tool_choice", "parallel_tool_calls", "text", "reasoning", "online", "include", "truncation", "max_output_tokens"); err != nil {
		apiError(w, 400, "invalid_request", err.Error())
		return
	}
	ignored, err := ignoredTokenLimits(tokenLimit{"max_output_tokens", body.MaxOutput})
	if err != nil {
		apiError(w, 400, "invalid_request", err.Error())
		return
	}
	if (body.Store != nil && *body.Store) || body.Background || (len(body.Previous) > 0 && string(body.Previous) != "null") || len(body.Include) > 0 || (body.Truncation != "" && body.Truncation != "disabled") {
		apiError(w, 400, "unsupported_parameter", "Responses is stateless: storage, background requests, previous_response_id, include, and automatic truncation are not supported")
		return
	}
	messages, err := responseMessages(body.Input, body.Instructions)
	if err != nil {
		apiError(w, 400, "invalid_request", err.Error())
		return
	}
	tools, err := parseTools(body.Tools, body.ToolChoice, body.Parallel, true)
	if err != nil {
		apiError(w, 400, "invalid_request", err.Error())
		return
	}
	var text struct {
		Format json.RawMessage `json:"format"`
	}
	if len(body.Text) > 0 && string(body.Text) != "null" {
		if err := decodeObject(body.Text, &text, "format"); err != nil {
			apiError(w, 400, "invalid_request", err.Error())
			return
		}
	}
	format, err := parseFormat(text.Format, true)
	if err != nil {
		apiError(w, 400, "invalid_request", err.Error())
		return
	}
	var reasoning struct {
		Effort *string `json:"effort"`
	}
	if len(body.Reasoning) > 0 && string(body.Reasoning) != "null" {
		if err := decodeObject(body.Reasoning, &reasoning, "effort"); err != nil {
			apiError(w, 400, "unsupported_parameter", "Only reasoning.effort is supported; reasoning summaries and encrypted state are unavailable")
			return
		}
	}
	generation := generationRequest{model: body.Model, messages: messages, stream: body.Stream, effort: reasoning.Effort, online: body.Online, tools: tools, format: format}
	if err := generation.prepare(); err != nil {
		apiError(w, 400, "invalid_request", err.Error())
		return
	}
	if ignored != "" {
		w.Header().Set("X-XIPU-Ignored-Parameters", ignored)
	}
	s.generate(w, r, generation, &responsesOutput{writer: w, parallel: tools.parallel})
}

type responsesOutput struct {
	writer               http.ResponseWriter
	id, messageID, model string
	created              int64
	sequence             int
	messageAdded         bool
	text                 strings.Builder
	parallel             bool
}

func (o *responsesOutput) initialize(id, model string, created int64) {
	o.id = "resp_" + id
	o.messageID = "msg_" + id
	o.model = model
	o.created = created
}
func responseText(text string) map[string]any {
	return map[string]any{"type": "output_text", "text": text, "annotations": []any{}, "logprobs": []any{}}
}
func (o *responsesOutput) message(text, status string) map[string]any {
	return map[string]any{"id": o.messageID, "type": "message", "status": status, "role": "assistant", "content": []any{responseText(text)}}
}
func responseCall(call toolCall, status string) map[string]any {
	return map[string]any{"id": "fc_" + call.ID, "type": "function_call", "status": status, "call_id": call.ID, "name": call.Function.Name, "arguments": call.Function.Arguments}
}
func (o *responsesOutput) response(result generationResult, status string, failure any) map[string]any {
	output := []any{}
	itemStatus := "completed"
	if status == "failed" {
		itemStatus = "incomplete"
	}
	if result.content != "" {
		output = append(output, o.message(result.content, itemStatus))
	}
	for _, call := range result.calls {
		output = append(output, responseCall(call, itemStatus))
	}
	return map[string]any{"id": o.id, "object": "response", "created_at": o.created, "status": status, "error": failure, "incomplete_details": nil, "model": o.model, "output": output, "store": false, "usage": nil, "parallel_tool_calls": o.parallel, "metadata": map[string]any{}}
}
func (o *responsesOutput) event(kind string, fields map[string]any) error {
	fields["type"] = kind
	fields["sequence_number"] = o.sequence
	o.sequence++
	return writeSSE(o.writer, kind, fields)
}
func (o *responsesOutput) start(id, model string, created int64) error {
	o.initialize(id, model, created)
	response := o.response(generationResult{}, "in_progress", nil)
	if err := o.event("response.created", map[string]any{"response": response}); err != nil {
		return err
	}
	return o.event("response.in_progress", map[string]any{"response": response})
}
func (o *responsesOutput) delta(part pieces) error {
	// School reasoning is raw text, not a Responses reasoning summary or encrypted state.
	if part.content == "" {
		return nil
	}
	if !o.messageAdded {
		o.messageAdded = true
		item := map[string]any{"id": o.messageID, "type": "message", "status": "in_progress", "role": "assistant", "content": []any{}}
		if err := o.event("response.output_item.added", map[string]any{"output_index": 0, "item": item}); err != nil {
			return err
		}
		if err := o.event("response.content_part.added", map[string]any{"item_id": o.messageID, "output_index": 0, "content_index": 0, "part": responseText("")}); err != nil {
			return err
		}
	}
	o.text.WriteString(part.content)
	return o.event("response.output_text.delta", map[string]any{"item_id": o.messageID, "output_index": 0, "content_index": 0, "delta": part.content, "logprobs": []any{}})
}
func (o *responsesOutput) finish(result generationResult) error {
	index := 0
	if o.messageAdded {
		if err := o.event("response.output_text.done", map[string]any{"item_id": o.messageID, "output_index": 0, "content_index": 0, "text": result.content, "logprobs": []any{}}); err != nil {
			return err
		}
		if err := o.event("response.content_part.done", map[string]any{"item_id": o.messageID, "output_index": 0, "content_index": 0, "part": responseText(result.content)}); err != nil {
			return err
		}
		if err := o.event("response.output_item.done", map[string]any{"output_index": 0, "item": o.message(result.content, "completed")}); err != nil {
			return err
		}
		index++
	}
	for _, call := range result.calls {
		item := responseCall(call, "in_progress")
		item["arguments"] = ""
		if err := o.event("response.output_item.added", map[string]any{"output_index": index, "item": item}); err != nil {
			return err
		}
		fields := map[string]any{"item_id": "fc_" + call.ID, "output_index": index, "delta": call.Function.Arguments}
		if err := o.event("response.function_call_arguments.delta", fields); err != nil {
			return err
		}
		if err := o.event("response.function_call_arguments.done", map[string]any{"item_id": "fc_" + call.ID, "output_index": index, "name": call.Function.Name, "arguments": call.Function.Arguments}); err != nil {
			return err
		}
		if err := o.event("response.output_item.done", map[string]any{"output_index": index, "item": responseCall(call, "completed")}); err != nil {
			return err
		}
		index++
	}
	return o.event("response.completed", map[string]any{"response": o.response(result, "completed", nil)})
}
func (o *responsesOutput) fail(err error) {
	_, code := errorStatus(err)
	failure := map[string]any{"code": code, "message": err.Error()}
	o.event("response.failed", map[string]any{"response": o.response(generationResult{content: o.text.String()}, "failed", failure)})
}

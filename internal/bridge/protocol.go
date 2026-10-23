// Package bridge exposes the loopback OpenAI-compatible API.
package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

type functionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}
type toolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function functionCall `json:"function"`
}
type message struct {
	Role        string          `json:"role"`
	Content     json.RawMessage `json:"content"`
	ToolCalls   []toolCall      `json:"tool_calls,omitempty"`
	ToolCallID  string          `json:"tool_call_id,omitempty"`
	Name        string          `json:"name,omitempty"`
	contentPath string
}

func (call *functionCall) UnmarshalJSON(raw []byte) error {
	type wire functionCall
	return decodeObject(raw, (*wire)(call), "name", "arguments")
}
func (call *toolCall) UnmarshalJSON(raw []byte) error {
	type wire toolCall
	return decodeObject(raw, (*wire)(call), "id", "type", "function")
}
func (item *message) UnmarshalJSON(raw []byte) error {
	type wire message
	if err := decodeObject(raw, (*wire)(item), "role", "content", "tool_calls", "tool_call_id", "name", "reasoning_content"); err != nil {
		return err
	}
	if item.Name != "" && !validName(item.Name) {
		return errors.New("Invalid message name")
	}
	return nil
}

const maxAttachments = 10

func contentParts(raw json.RawMessage, attachments *[]attachmentInput) (string, error) {
	return renderContentParts(raw, attachments, false, maxAttachments, "")
}

const omittedImageText = "[Earlier image omitted; image content is unavailable. Use only the existing text descriptions.]"

func validateOmittedImageURL(raw string) error {
	if strings.HasPrefix(raw, "data:") {
		header, encoded, ok := strings.Cut(raw[5:], ",")
		if !ok || !strings.HasSuffix(header, ";base64") || !supportedImageMIME(strings.TrimSuffix(header, ";base64")) || encoded == "" {
			return errors.New("Historical image must use a supported, nonempty base64 data URL")
		}
		return nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || validateImageURL(parsed) != nil {
		return errors.New("Historical image URL must be public HTTPS without credentials")
	}
	return nil
}

func renderContentParts(raw json.RawMessage, attachments *[]attachmentInput, omitImages bool, attachmentLimit int, contentPath string) (rendered string, err error) {
	parameter := contentPath
	defer func() {
		if parameter != "" {
			err = atParameter(err, parameter)
		}
	}()
	if len(raw) == 0 || string(raw) == "null" {
		return "", nil
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text, nil
	}
	var parts []json.RawMessage
	if json.Unmarshal(raw, &parts) != nil {
		return "", errors.New("Message content must be text or content parts")
	}
	var texts []string
	for index, raw := range parts {
		if contentPath != "" {
			parameter = fmt.Sprintf("%s[%d]", contentPath, index)
		}
		var kind struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &kind) != nil {
			return "", errors.New("Invalid message content part")
		}
		if kind.Type == "input_file" || kind.Type == "file" {
			file, err := parseFileInput(raw, kind.Type)
			if err != nil {
				return "", err
			}
			if attachmentLimit > 0 && len(*attachments) >= attachmentLimit {
				return "", fmt.Errorf("At most %d attachments are supported", attachmentLimit)
			}
			*attachments = append(*attachments, attachmentInput{File: &file, Param: fmt.Sprintf("%s[%d]", contentPath, index)})
			texts = append(texts, fmt.Sprintf("[File %d: %s]", len(*attachments), file.Name))
			continue
		}
		var part struct {
			Type     string          `json:"type"`
			Text     string          `json:"text"`
			ImageURL json.RawMessage `json:"image_url"`
			Detail   string          `json:"detail"`
		}
		if err := decodeObject(raw, &part, "type", "text", "image_url", "detail", "annotations", "logprobs"); err != nil {
			return "", err
		}
		switch part.Type {
		case "text", "input_text", "output_text":
			texts = append(texts, part.Text)
		case "image_url", "input_image":
			var url string
			if json.Unmarshal(part.ImageURL, &url) != nil {
				var image struct {
					URL    string `json:"url"`
					Detail string `json:"detail"`
				}
				if err := decodeObject(part.ImageURL, &image, "url", "detail"); err != nil {
					return "", errors.New("Invalid image URL")
				}
				url = image.URL
				part.Detail = image.Detail
			}
			if part.Detail != "" && part.Detail != "auto" {
				return "", errors.New("Image detail selection is not supported; use auto")
			}
			if url == "" {
				return "", errors.New("Image URL is required")
			}
			if omitImages {
				if err := validateOmittedImageURL(url); err != nil {
					return "", err
				}
				texts = append(texts, omittedImageText)
				continue
			}
			if attachmentLimit > 0 && len(*attachments) >= attachmentLimit {
				return "", fmt.Errorf("At most %d attachments are supported", attachmentLimit)
			}
			*attachments = append(*attachments, attachmentInput{ImageURL: url, Param: fmt.Sprintf("%s[%d]", contentPath, index)})
			texts = append(texts, fmt.Sprintf("[Image %d]", len(*attachments)))
		default:
			return "", errors.New("Unsupported message content type")
		}
	}
	return strings.Join(texts, "\n"), nil
}
func contentText(raw json.RawMessage) (string, error) {
	var attachments []attachmentInput
	return contentParts(raw, &attachments)
}

func buildTranscript(messages []message) (string, []attachmentInput, error) {
	return renderTranscript(messages, false, maxAttachments)
}

func renderTranscript(messages []message, omitHistoricalImages bool, attachmentLimit int) (string, []attachmentInput, error) {
	omitBefore := -1
	if omitHistoricalImages {
		latestUser := -1
		for i, item := range messages {
			if item.Role == "user" || item.Role == "" {
				latestUser = i
			}
		}
		for i := 0; i < latestUser; i++ {
			if messages[i].Role == "assistant" {
				omitBefore = i
			}
		}
	}
	var blocks, roles []string
	var attachments []attachmentInput
	pending := map[string]bool{}
	seen := map[string]bool{}
	for index, item := range messages {
		role := item.Role
		if role == "" {
			role = "user"
		}
		switch role {
		case "user", "assistant", "system", "developer", "tool":
		default:
			return "", nil, errors.New("Unsupported message role")
		}
		if role != "tool" && len(pending) > 0 {
			return "", nil, errors.New("Every tool call must have a matching result before the next message")
		}
		contentPath := item.contentPath
		if contentPath == "" {
			contentPath = fmt.Sprintf("messages[%d].content", index)
		}
		text, err := renderContentParts(item.Content, &attachments, index < omitBefore, attachmentLimit, contentPath)
		if err != nil {
			return "", nil, err
		}
		if item.ToolCallID != "" && role != "tool" {
			return "", nil, errors.New("tool_call_id is only valid for tool results")
		}
		if len(item.ToolCalls) > 0 {
			if role != "assistant" {
				return "", nil, errors.New("Tool calls must belong to assistant messages")
			}
			for _, call := range item.ToolCalls {
				if call.Type != "function" || !validName(call.Function.Name) || !validCallID(call.ID) || seen[call.ID] {
					return "", nil, errors.New("Invalid or duplicate tool call")
				}
				value, err := exactJSON([]byte(call.Function.Arguments))
				if err != nil {
					return "", nil, errors.New("Tool arguments must be a JSON object")
				}
				if _, ok := value.(map[string]any); !ok {
					return "", nil, errors.New("Tool arguments must be a JSON object")
				}
				seen[call.ID] = true
				pending[call.ID] = true
			}
			data, _ := json.Marshal(item.ToolCalls)
			text += "\n[tool_calls]\n" + string(data)
		}
		if role == "tool" {
			if !pending[item.ToolCallID] {
				return "", nil, errors.New("Tool result does not match a pending call ID")
			}
			delete(pending, item.ToolCallID)
			data, _ := json.Marshal(map[string]string{"tool_call_id": item.ToolCallID, "output": text})
			text = string(data)
		}
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		blocks = append(blocks, text)
		roles = append(roles, role)
	}
	if len(pending) > 0 {
		return "", nil, errors.New("Tool call results are required for stateless replay")
	}
	if len(blocks) == 1 && roles[0] == "user" {
		return blocks[0], attachments, nil
	}
	for i := range blocks {
		blocks[i] = "[" + roles[i] + "]\n" + blocks[i]
	}
	return strings.Join(blocks, "\n\n"), attachments, nil
}
func transcript(messages []message) (string, error) {
	text, _, err := buildTranscript(messages)
	return text, err
}

func thinking(value, fallback string) string {
	if value == "" {
		value = fallback
	}
	switch strings.ToLower(value) {
	case "low", "medium", "high":
		return strings.ToLower(value)
	default:
		return "minimal"
	}
}

func schoolError(event map[string]json.RawMessage) error {
	code := strings.Trim(string(event["code"]), `"`)
	if code == "" || code == "0" || code == "null" {
		return nil
	}
	for _, field := range []string{"msg", "message", "data"} {
		var text string
		if json.Unmarshal(event[field], &text) == nil && text != "" {
			return fmt.Errorf("%s (code=%s)", text, code)
		}
	}
	return fmt.Errorf("school API error (code=%s)", code)
}

type pieces struct{ content, reasoning string }
type parser struct{ sawContent, sawReasoning bool }

func (p *parser) parse(raw json.RawMessage) (pieces, error) {
	var event map[string]json.RawMessage
	if err := json.Unmarshal(raw, &event); err != nil || event == nil {
		return pieces{}, invalidSchoolResponse("generation", "invalid school event")
	}
	if err := schoolError(event); err != nil {
		return pieces{}, err
	}
	var kind string
	json.Unmarshal(event["type"], &kind)
	var result pieces
	if kind == "string" {
		json.Unmarshal(event["data"], &result.content)
		json.Unmarshal(event["reasoning_data"], &result.reasoning)
	} else if kind == "object" {
		var data struct {
			Text   string `json:"aiText"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(event["data"], &data); err != nil {
			return pieces{}, invalidSchoolResponse("generation", "invalid school result")
		}
		if !p.sawContent {
			result.content = data.Text
		}
		if !p.sawReasoning {
			result.reasoning = data.Reason
		}
	}
	p.sawContent = p.sawContent || result.content != ""
	p.sawReasoning = p.sawReasoning || result.reasoning != ""
	return result, nil
}

func models(raw json.RawMessage) (map[string]any, error) {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil || body == nil {
		return nil, invalidSchoolResponse("model_catalog", "invalid model catalog")
	}
	if err := schoolError(body); err != nil {
		return nil, err
	}
	var data map[string]json.RawMessage
	itemsRaw := body["data"]
	if json.Unmarshal(itemsRaw, &data) == nil && data != nil {
		itemsRaw = data["models"]
	}
	var items []json.RawMessage
	if json.Unmarshal(itemsRaw, &items) != nil {
		return nil, invalidSchoolResponse("model_catalog", "invalid model catalog")
	}
	output := make([]map[string]any, 0, len(items))
	for _, raw := range items {
		var id, label string
		if json.Unmarshal(raw, &id) == nil {
			label = id
		} else {
			var item map[string]string
			// Catalog objects may also contain non-string pricing metadata.
			var values map[string]json.RawMessage
			if json.Unmarshal(raw, &values) != nil {
				continue
			}
			item = make(map[string]string)
			for _, key := range []string{"value", "model", "name", "label"} {
				var value string
				json.Unmarshal(values[key], &value)
				item[key] = value
			}
			for _, key := range []string{"value", "model", "name"} {
				if item[key] != "" {
					id = item[key]
					break
				}
			}
			label = item["label"]
			if label == "" {
				label = item["name"]
			}
			if label == "" {
				label = id
			}
		}
		if id != "" {
			output = append(output, map[string]any{"id": id, "object": "model", "created": 0, "owned_by": "xipu", "name": label})
		}
	}
	return map[string]any{"object": "list", "data": output}, nil
}

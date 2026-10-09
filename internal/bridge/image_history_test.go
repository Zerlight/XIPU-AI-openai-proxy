package bridge

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

func historyImage(url string) json.RawMessage {
	data, _ := json.Marshal([]any{map[string]any{"type": "text", "text": "Existing user text"}, map[string]any{"type": "image_url", "image_url": map[string]string{"url": url}}})
	return data
}

func historyText(role, text string) message {
	data, _ := json.Marshal(text)
	return message{Role: role, Content: data}
}

func TestHistoricalImageBoundary(t *testing.T) {
	old := message{Role: "user", Content: historyImage("https://images.example/old.png")}
	current := message{Role: "user", Content: historyImage("https://images.example/current.png")}
	answer := historyText("assistant", "Existing assistant description")
	followup := historyText("user", "Text follow-up")
	tool := message{Role: "assistant", ToolCalls: []toolCall{{ID: "call_a", Type: "function", Function: functionCall{Name: "lookup", Arguments: `{}`}}}}
	result := message{Role: "tool", ToolCallID: "call_a", Content: json.RawMessage(`"Existing tool result"`)}
	for _, item := range []struct {
		name     string
		messages []message
		omit     bool
		wantURLs string
		markers  int
	}{
		{"default preserves history", []message{old, answer, followup}, false, "old.png", 0},
		{"answered image omitted", []message{old, answer, followup}, true, "", 1},
		{"current image retained", []message{current}, true, "current.png", 0},
		{"consecutive users retained", []message{old, followup}, true, "old.png", 0},
		{"consecutive users after answer", []message{old, answer, current, followup}, true, "current.png", 1},
		{"tool continuation retained", []message{old, tool, result}, true, "old.png", 0},
		{"older turn omitted during tools", []message{old, answer, current, tool, result}, true, "current.png", 1},
		{"empty role is user", []message{old, answer, historyText("", "Text follow-up")}, true, "", 1},
		{"assistant without later user", []message{old, answer}, true, "old.png", 0},
	} {
		t.Run(item.name, func(t *testing.T) {
			text, urls, err := renderTranscript(item.messages, item.omit, 4)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Count(text, omittedImageText) != item.markers {
				t.Fatalf("wrong omission markers: %s", text)
			}
			if item.wantURLs == "" {
				if len(urls) != 0 {
					t.Fatalf("historical images retained: %v", urls)
				}
			} else if len(urls) != 1 || !strings.HasSuffix(urls[0], item.wantURLs) || !strings.Contains(text, "[Image 1]") {
				t.Fatalf("wrong retained images: %v %s", urls, text)
			}
			if !strings.Contains(text, "Existing user text") {
				t.Fatal("image omission removed existing text")
			}
			for _, original := range item.messages {
				if original.Role == "assistant" && string(original.Content) == string(answer.Content) && !strings.Contains(text, "Existing assistant description") {
					t.Fatal("image omission removed the existing description")
				}
			}
		})
	}
}

func TestHistoricalImagesStillValidateParts(t *testing.T) {
	for _, raw := range []string{
		`[{"type":"image_url","image_url":{"url":"https://images.example/old.png","detail":"high"}}]`,
		`[{"type":"image_url","image_url":{"url":"https://images.example/old.png","unknown":true}}]`,
		`[{"type":"image_url","image_url":false}]`,
		`[{"type":"image_url","image_url":{"url":""}}]`,
		`[{"type":"image_url","image_url":{"url":"http://images.example/old.png"}}]`,
		`[{"type":"image_url","image_url":{"url":"https://user:secret@images.example/old.png"}}]`,
		`[{"type":"input_image","image_url":"data:image/png,not-base64"}]`,
		`[{"type":"input_image","image_url":"data:image/svg+xml;base64,AAAA"}]`,
		`[{"type":"input_image","image_url":"data:image/png;base64,"}]`,
		`[{"type":"input_file","file_id":"not-an-image"}]`,
	} {
		messages := []message{{Role: "user", Content: json.RawMessage(raw)}, historyText("assistant", "Existing description"), historyText("user", "Follow-up")}
		if _, _, err := renderTranscript(messages, true, 4); err == nil {
			t.Fatalf("accepted malformed omitted image: %s", raw)
		}
	}
}

func TestHistoricalImageLimitsApplyToRetainedImages(t *testing.T) {
	var parts []any
	for range 5 {
		parts = append(parts, map[string]any{"type": "input_image", "image_url": "https://images.example/old.png"})
	}
	content, _ := json.Marshal(parts)
	messages := []message{{Role: "user", Content: content}, historyText("assistant", "Existing description"), historyText("user", "Follow-up")}
	request := generationRequest{messages: messages}
	if err := request.prepare(); err != nil {
		t.Fatalf("raw validation applied the limit before the settings snapshot: %v", err)
	}
	if _, _, err := renderTranscript(messages, false, 4); err == nil {
		t.Fatal("default mode accepted more than four images")
	}
	text, urls, err := renderTranscript(messages, true, 4)
	if err != nil || len(urls) != 0 || strings.Count(text, omittedImageText) != 5 {
		t.Fatalf("omitted images consumed the retained-image budget: %v %v", urls, err)
	}
	if _, _, err := renderTranscript(messages[:1], true, 4); err == nil {
		t.Fatal("current images bypassed the four-image limit")
	}
}

func TestHistoricalImagePolicyInChatAndResponsesPayload(t *testing.T) {
	validURL := imageDataURL("image/png", testRaster(t, "png"))
	for _, path := range []string{"/v1/chat/completions", "/v1/responses"} {
		for _, omit := range []bool{false, true} {
			t.Run(path+map[bool]string{false: "/default", true: "/omit"}[omit], func(t *testing.T) {
				settings := config.Defaults().Settings
				settings.OmitHistoricalImages = omit
				sent := make(chan map[string]any, 2)
				s := New(Options{Key: "synthetic-local-key", Settings: settings, Send: func(value any) error { sent <- value.(map[string]any); return nil }})
				t.Cleanup(s.Close)
				if err := s.Receive(map[string]json.RawMessage{"type": json.RawMessage(`"status"`), "tabs": json.RawMessage(`1`)}); err != nil {
					t.Fatal(err)
				}
				oldURL := validURL
				if omit {
					// Invalid raster bytes prove omitted image content is never decoded.
					oldURL = "data:image/png;base64,bm90LWFuLWltYWdl"
				}
				messages := []message{{Role: "user", Content: historyImage(oldURL)}, historyText("assistant", "Existing assistant description"), {Role: "user", Content: historyImage(validURL)}}
				body := map[string]any{"model": "synthetic-model"}
				if path == "/v1/responses" {
					for _, index := range []int{0, 2} {
						url := validURL
						if index == 0 {
							url = oldURL
						}
						messages[index].Content, _ = json.Marshal([]any{map[string]string{"type": "input_text", "text": "Existing user text"}, map[string]string{"type": "input_image", "image_url": url}})
					}
					body["input"] = messages
					body["store"] = false
				} else {
					body["messages"] = messages
				}
				raw, _ := json.Marshal(body)
				pending := recordedRequest(s, path, string(raw))
				job := take(t, sent)
				payload := job["payload"].(map[string]any)
				images := payload["images"].([]imageAttachment)
				wantImages := 2
				if omit {
					wantImages = 1
				}
				text := payload["text"].(string)
				if len(images) != wantImages || strings.Contains(text, omittedImageText) != omit || !strings.Contains(text, "Existing assistant description") {
					t.Fatalf("wrong school payload: images=%d text=%s", len(images), text)
				}
				completeText(t, s, job, "Answer")
				if result := <-pending; result.Code != 200 {
					t.Fatalf("request failed: %s", result.Body)
				}
			})
		}
	}
}

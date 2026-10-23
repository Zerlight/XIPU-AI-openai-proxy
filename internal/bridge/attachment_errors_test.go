package bridge

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

func sendAttachmentError(t *testing.T, s *Server, job map[string]any, index json.RawMessage) {
	t.Helper()
	event := map[string]any{
		"job": job["job"], "kind": "done", "code": "attachment_upload_failed", "message": "Upload failed",
		"param": "untrusted.path", "attachment": map[string]any{"filename": "untrusted.txt"},
	}
	if index != nil {
		event["attachment_index"] = index
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Receive(map[string]json.RawMessage{"type": json.RawMessage(`"evt"`), "evt": raw}); err != nil {
		t.Fatal(err)
	}
}

func TestAttachmentUploadErrorsPreserveRequestLocations(t *testing.T) {
	image, _ := json.Marshal(imageDataURL("image/png", testRaster(t, "png")))
	chat := `"messages":[{"role":"user","content":[{"type":"text","text":"Inspect"},{"type":"file","file":{"filename":"duplicate.txt","file_data":"QQ=="}},{"type":"image_url","image_url":` + string(image) + `},{"type":"file","file":{"filename":"duplicate.txt","file_data":"Qg=="}}]}]`
	responses := `"instructions":"Be concise","input":[
		{"role":"user","content":[{"type":"input_text","text":"Inspect"},{"type":"input_image","image_url":"https://images.example/old.png"},{"type":"input_file","filename":"duplicate.txt","file_data":"QQ=="}]},
		{"role":"assistant","content":"Existing description"},
		{"type":"function_call","name":"inspect","arguments":"{}","call_id":"call_a"},
		{"type":"function_call","name":"inspect","arguments":"{}","call_id":"call_b"},
		{"type":"function_call_output","call_id":"call_a","output":[{"type":"input_text","text":"Result"},{"type":"input_file","filename":"duplicate.txt","file_data":"Qg=="}]},
		{"type":"function_call_output","call_id":"call_b","output":"Result"},
		{"role":"user","content":[{"type":"input_text","text":"Continue"},{"type":"input_file","filename":"current.txt","file_data":"Qw=="}]}
	]`
	for _, item := range []struct {
		endpoint, input, param, filename, kind string
		index                                  int
	}{
		{"chat/completions", chat, "messages[0].content[2]", "image.png", "image", 1},
		{"chat/completions", chat, "messages[0].content[3]", "duplicate.txt", "file", 2},
		{"responses", responses, "input[0].content[2]", "duplicate.txt", "file", 0},
		{"responses", responses, "input[4].output[1]", "duplicate.txt", "file", 1},
		{"responses", responses, "input[6].content[1]", "current.txt", "file", 2},
	} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/%s/stream=%v", item.endpoint, item.param, stream), func(t *testing.T) {
				sent := make(chan map[string]any, 2)
				settings := config.Defaults().Settings
				settings.OmitHistoricalImages = true
				s := New(Options{Key: "synthetic-local-key", Settings: settings, Send: func(value any) error { sent <- value.(map[string]any); return nil }})
				t.Cleanup(s.Close)
				s.Receive(map[string]json.RawMessage{"type": json.RawMessage(`"status"`), "tabs": json.RawMessage(`1`)})
				body := fmt.Sprintf(`{"model":"synthetic-model","stream":%v,%s}`, stream, item.input)
				pending := recordedRequest(s, "/v1/"+item.endpoint, body)
				job := take(t, sent)
				if attachments := job["payload"].(map[string]any)["attachments"].([]attachment); len(attachments) != 3 {
					t.Fatalf("unexpected retained attachment count: %d", len(attachments))
				}
				sendAttachmentError(t, s, job, json.RawMessage(fmt.Sprint(item.index)))
				result := <-pending
				var response map[string]any
				if err := json.Unmarshal(result.Body.Bytes(), &response); err != nil {
					t.Fatalf("expected JSON error before SSE: %v", err)
				}
				want := map[string]any{"error": map[string]any{
					"message": fmt.Sprintf("Attachment %d/3 (%s): Upload failed", item.index+1, item.filename), "type": "bridge_error", "code": "attachment_upload_failed", "param": item.param,
					"attachment": map[string]any{"index": float64(item.index), "total": float64(3), "filename": item.filename, "kind": item.kind},
				}}
				if result.Code != 502 || !strings.HasPrefix(result.Header().Get("Content-Type"), "application/json") || !reflect.DeepEqual(response, want) {
					t.Fatalf("wrong attachment error: %d %s", result.Code, result.Body)
				}
				select {
				case <-sent:
					t.Fatal("upload failure was retried")
				default:
				}
				health := httptest.NewRecorder()
				s.ServeHTTP(health, httptest.NewRequest("GET", "http://localhost/health", nil))
				if !strings.Contains(health.Body.String(), `"busy":false`) {
					t.Fatal("upload failure left the bridge busy")
				}
			})
		}
	}
}

func TestAttachmentUploadErrorsRejectUnverifiedIndices(t *testing.T) {
	for _, index := range []string{"", "null", "-1", "1", "1.5", `"0"`, "true", "[]", "{}", "999999999999999999999999"} {
		t.Run(index, func(t *testing.T) {
			sent := make(chan map[string]any, 2)
			s := New(Options{Key: "synthetic-local-key", Settings: config.Defaults().Settings, Send: func(value any) error { sent <- value.(map[string]any); return nil }})
			t.Cleanup(s.Close)
			s.Receive(map[string]json.RawMessage{"type": json.RawMessage(`"status"`), "tabs": json.RawMessage(`1`)})
			pending := recordedRequest(s, "/v1/responses", `{"model":"synthetic-model","stream":true,"input":[{"role":"user","content":[{"type":"input_file","filename":"sample.txt","file_data":"QQ=="}]}]}`)
			job := take(t, sent)
			var raw json.RawMessage
			if index != "" {
				raw = json.RawMessage(index)
			}
			sendAttachmentError(t, s, job, raw)
			result := <-pending
			var response map[string]any
			json.Unmarshal(result.Body.Bytes(), &response)
			want := map[string]any{"error": map[string]any{"message": "Upload failed", "code": "upstream_error", "type": "bridge_error"}}
			if result.Code != 502 || !reflect.DeepEqual(response, want) {
				t.Fatalf("invalid ordinal identified an attachment: %s", result.Body)
			}
		})
	}
}

func TestAttachmentUploadDetailsSurviveStreamFailures(t *testing.T) {
	details := &attachmentFailure{Index: 1, Total: 3, Filename: "sample.txt", Kind: "file", param: "input[0].content[2]"}
	err := &attachmentUploadError{message: "Upload failed", index: 1, details: details}
	for _, responses := range []bool{false, true} {
		writer := httptest.NewRecorder()
		var output generationOutput = &chatOutput{writer: writer}
		if responses {
			output = &responsesOutput{writer: writer}
		}
		output.start("synthetic-job", "synthetic-model", 0)
		output.fail(err)
		body := writer.Body.String()
		for _, value := range []string{`"message":"Attachment 2/3 (sample.txt): Upload failed"`, `"param":"input[0].content[2]"`, `"index":1`, `"filename":"sample.txt"`, `"code":"attachment_upload_failed"`} {
			if !strings.Contains(body, value) {
				t.Fatalf("stream lost attachment error field %s: %s", value, body)
			}
		}
	}
}

func TestAttachmentUploadMessageUsesOnlyConfirmedMetadata(t *testing.T) {
	for _, item := range []struct {
		name, message, want string
		index               int
		details             *attachmentFailure
	}{
		{"unconfirmed", "Upload failed", "Upload failed", 0, nil},
		{"negative-index", "Upload failed", "Upload failed", -1, &attachmentFailure{Index: -1, Total: 3, Filename: "sample.txt"}},
		{"out-of-range", "Upload failed", "Upload failed", 3, &attachmentFailure{Index: 3, Total: 3, Filename: "sample.txt"}},
		{"empty-total", "Upload failed", "Upload failed", 0, &attachmentFailure{Index: 0, Total: 0, Filename: "sample.txt"}},
		{"mismatched-index", "Upload failed", "Upload failed", 0, &attachmentFailure{Index: 1, Total: 3, Filename: "sample.txt"}},
		{"legacy-file", `Upload file 2/3 ("sample.txt"): Upload failed`, "Attachment 2/3 (sample.txt): Upload failed", 1, &attachmentFailure{Index: 1, Total: 3, Filename: "sample.txt", Kind: "file"}},
		{"legacy-image", `Upload image 1/1 ("image.png"): Upload failed`, "Attachment 1/1 (image.png): Upload failed", 0, &attachmentFailure{Index: 0, Total: 1, Filename: "image.png", Kind: "image"}},
		{"unmatched-legacy-label", `Upload file 1/3 ("other.txt"): Upload failed`, `Attachment 2/3 (sample.txt): Upload file 1/3 ("other.txt"): Upload failed`, 1, &attachmentFailure{Index: 1, Total: 3, Filename: "sample.txt", Kind: "file"}},
	} {
		t.Run(item.name, func(t *testing.T) {
			err := &attachmentUploadError{message: item.message, index: item.index, details: item.details}
			if got := err.Error(); got != item.want {
				t.Fatalf("unexpected attachment message: %q", got)
			}
			if got := err.Error(); got != item.want {
				t.Fatalf("formatting changed the original message: %q", got)
			}
		})
	}
}

func TestAttachmentUploadMessageRejectsUnsafeNames(t *testing.T) {
	for _, name := range []string{
		"", "../sample.txt", "/tmp/sample.txt", `C:\temp\sample.txt`, "nested/sample.txt",
		".sample.txt", "sample.txt.", "sample.txt ", "sample\n.txt", "sample\r.txt", "sample\t.txt",
		"sample\x00.txt", "sample\x1b.txt", "sample\u202e.txt", "sample\u2066.txt", "sample\u200e.txt",
		"sample\xff.txt", "sample (copy).txt", strings.Repeat("a", 125) + ".txt",
	} {
		t.Run(fmt.Sprintf("%q", name), func(t *testing.T) {
			err := &attachmentUploadError{message: "Upload failed", index: 1, details: &attachmentFailure{Index: 1, Total: 3, Filename: name, Kind: "file"}}
			if got := err.Error(); got != "Upload failed" {
				t.Fatalf("unsafe name entered the message: %q", got)
			}
		})
	}
}

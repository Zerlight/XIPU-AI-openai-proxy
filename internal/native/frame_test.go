package native

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	hostconfig "github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

type shortReader struct{ io.Reader }

func (r shortReader) Read(p []byte) (int, error) {
	if len(p) > 1 {
		p = p[:1]
	}
	return r.Reader.Read(p)
}

func TestOversizedRequestChunksRoundTrip(t *testing.T) {
	message := map[string]any{"type": "req", "job": "image-job", "op": "chat", "payload": map[string]any{"text": strings.Repeat("\u754c", MaxOutbound/2)}}
	expected, _ := json.Marshal(message)
	var output bytes.Buffer
	if err := (&Writer{Output: &output}).Send(message); err != nil {
		t.Fatal(err)
	}
	var assembled bytes.Buffer
	index := 0
	for output.Len() > 0 {
		if binary.NativeEndian.Uint32(output.Bytes()[:4]) >= MaxOutbound {
			t.Fatal("chunk exceeds native frame limit")
		}
		frame, err := Read(&output)
		if err != nil {
			t.Fatal(err)
		}
		var kind, job, data string
		var position, total, size int
		json.Unmarshal(frame["type"], &kind)
		json.Unmarshal(frame["job"], &job)
		json.Unmarshal(frame["data"], &data)
		json.Unmarshal(frame["index"], &position)
		json.Unmarshal(frame["total"], &total)
		json.Unmarshal(frame["size"], &size)
		if kind != "req_chunk" || job != "image-job" || position != index || total != (len(expected)+RequestChunkBytes-1)/RequestChunkBytes || size != len(expected) {
			t.Fatal("invalid chunk metadata")
		}
		decoded, err := base64.StdEncoding.Strict().DecodeString(data)
		if err != nil || len(decoded) != min(RequestChunkBytes, size-index*RequestChunkBytes) {
			t.Fatalf("invalid chunk size: %v", err)
		}
		assembled.Write(decoded)
		index++
	}
	if !bytes.Equal(expected, assembled.Bytes()) {
		t.Fatal("chunk reassembly changed JSON or Unicode")
	}
}

func TestChunkedRequestLimitsAndNoInterleaving(t *testing.T) {
	for _, message := range []any{
		map[string]any{"type": "req", "job": "large", "data": strings.Repeat("x", MaxRequest)},
		map[string]any{"type": "evt", "job": "wrong-kind", "data": strings.Repeat("x", MaxOutbound)},
		map[string]any{"type": "req", "data": strings.Repeat("x", MaxOutbound)},
	} {
		var output bytes.Buffer
		if err := (&Writer{Output: &output}).Send(message); err == nil || output.Len() != 0 {
			t.Fatal("invalid oversized message was partially written")
		}
	}
	var output bytes.Buffer
	writer := &Writer{Output: &output}
	var group sync.WaitGroup
	for _, job := range []string{"first", "second"} {
		group.Add(1)
		go func(job string) {
			defer group.Done()
			if err := writer.Send(map[string]any{"type": "req", "job": job, "data": strings.Repeat("x", MaxOutbound)}); err != nil {
				t.Error(err)
			}
		}(job)
	}
	group.Wait()
	var previous string
	changes := 0
	for output.Len() > 0 {
		frame, err := Read(&output)
		if err != nil {
			t.Fatal(err)
		}
		var job string
		json.Unmarshal(frame["job"], &job)
		if job != previous {
			changes++
			previous = job
		}
	}
	if changes != 2 {
		t.Fatal("concurrent request chunks interleaved")
	}
}

type shortWriter struct{ bytes.Buffer }

func (w *shortWriter) Write(p []byte) (int, error) {
	if len(p) > 2 {
		p = p[:2]
	}
	return w.Buffer.Write(p)
}

func TestFrameFragmentationAndUnicode(t *testing.T) {
	w := &shortWriter{}
	if err := (&Writer{Output: w}).Send(map[string]any{"text": "Unicode: \u4e2d\u6587"}); err != nil {
		t.Fatal(err)
	}
	message, err := Read(shortReader{&w.Buffer})
	if err != nil {
		t.Fatal(err)
	}
	var text string
	json.Unmarshal(message["text"], &text)
	if text != "Unicode: \u4e2d\u6587" {
		t.Fatalf("unexpected text %q", text)
	}
	if _, err := Read(&w.Buffer); !errors.Is(err, io.EOF) {
		t.Fatalf("expected clean EOF, got %v", err)
	}
}

func TestRejectInvalidFrames(t *testing.T) {
	frame := func(body []byte) []byte {
		header := make([]byte, 4)
		binary.NativeEndian.PutUint32(header, uint32(len(body)))
		return append(header, body...)
	}
	oversize := make([]byte, 4)
	binary.NativeEndian.PutUint32(oversize, MaxInbound+1)
	for _, input := range [][]byte{{1}, {0, 0, 0, 0}, oversize, frame([]byte("null")), frame([]byte("[]")), frame([]byte("{bad}")), frame([]byte{'{', '"', 'x', '"', ':', '"', 255, '"', '}'}), append([]byte{4, 0, 0, 0}, []byte("{")...)} {
		if _, err := Read(bytes.NewReader(input)); err == nil {
			t.Fatalf("accepted invalid frame %q", input)
		}
	}
	var out bytes.Buffer
	if err := (&Writer{Output: &out}).Send(map[string]any{"text": strings.Repeat("x", MaxOutbound)}); err == nil || out.Len() != 0 {
		t.Fatal("oversized message was written")
	}
}

func TestConfigAndKey(t *testing.T) {
	dir := t.TempDir()
	config := `{"allowed_origins":["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"]}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err := hostconfig.Load(dir)
	if err != nil || loaded.Port != 8765 || loaded.SessionName != "XIPU AI Bridge" {
		t.Fatalf("defaults failed: %+v %v", loaded, err)
	}
	key, err := ClientKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ClientKey(dir)
	if err != nil || key != second || len(key) < 24 {
		t.Fatal("key not reused")
	}
	if err := os.WriteFile(filepath.Join(dir, "api-key.txt"), []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ClientKey(dir); err == nil {
		t.Fatal("accepted weak stored key")
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"allowed_origins":["chrome-extension://*/"]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := hostconfig.Load(dir); err == nil {
		t.Fatal("accepted wildcard origin")
	}
}

package native

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	hostconfig "github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

func TestNativeHostHTTPRoundTripAndEOF(t *testing.T) {
	dir := t.TempDir()
	origin := "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
	settings := hostconfig.Defaults()
	settings.SessionName = "Synthetic Session"
	settings.Port = unusedPort(t)
	settings.AllowedOrigins = []string{origin}
	config, _ := json.Marshal(settings)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), config, 0600); err != nil {
		t.Fatal(err)
	}
	input, chromeOutput := io.Pipe()
	chromeInput, output := io.Pipe()
	t.Cleanup(func() { input.Close(); chromeOutput.Close(); chromeInput.Close(); output.Close() })
	finished := make(chan error, 1)
	go func() { finished <- Run(context.Background(), input, output, origin, dir) }()
	ready, err := Read(chromeInput)
	if err != nil {
		t.Fatal(err)
	}
	var base, key, session string
	json.Unmarshal(ready["base_url"], &base)
	json.Unmarshal(ready["api_key"], &key)
	var publicSettings hostconfig.Settings
	json.Unmarshal(ready["config"], &publicSettings)
	session = publicSettings.SessionName
	if base == "" || len(key) < 24 || session != "Synthetic Session" {
		t.Fatal("invalid ready frame")
	}
	writer := &Writer{Output: chromeOutput}
	if err := writer.Send(map[string]any{"type": "status", "tabs": 1}); err != nil {
		t.Fatal(err)
	}
	type result struct {
		code int
		text string
		err  error
	}
	response := make(chan result, 1)
	go func() {
		req, _ := http.NewRequest("GET", base+"/models", nil)
		req.Header.Set("Authorization", "Bearer "+key)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			response <- result{err: err}
			return
		}
		defer res.Body.Close()
		data, err := io.ReadAll(res.Body)
		response <- result{code: res.StatusCode, text: string(data), err: err}
	}()
	request, err := Read(chromeInput)
	if err != nil {
		t.Fatal(err)
	}
	var job string
	json.Unmarshal(request["job"], &job)
	if job == "" || string(request["op"]) != `"models"` {
		t.Fatal("invalid request frame")
	}
	if err := writer.Send(map[string]any{"type": "evt", "evt": map[string]any{"job": job, "kind": "result", "result": map[string]any{"code": 0, "data": map[string]any{"models": []string{"synthetic-model"}}}}}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Send(map[string]any{"type": "evt", "evt": map[string]any{"job": job, "kind": "done"}}); err != nil {
		t.Fatal(err)
	}
	got := <-response
	if got.err != nil || got.code != 200 || !strings.Contains(got.text, `"id":"synthetic-model"`) {
		t.Fatalf("HTTP round trip failed: %+v", got)
	}
	chromeOutput.Close()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("native host did not exit on EOF")
	}
	address := strings.TrimSuffix(strings.TrimPrefix(base, "http://"), "/v1")
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		t.Fatal("port not released after EOF", err)
	}
	listener.Close()
}

func TestUnauthorizedOriginDoesNotCreateKey(t *testing.T) {
	dir := t.TempDir()
	config := `{"allowed_origins":["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"]}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	err := Run(context.Background(), strings.NewReader(""), io.Discard, "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/", dir)
	if err == nil {
		t.Fatal("unauthorized origin accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "api-key.txt")); !os.IsNotExist(err) {
		t.Fatal("key created before origin authorization")
	}
}

func unusedPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

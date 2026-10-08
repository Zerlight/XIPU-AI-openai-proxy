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

func TestSettingsRPCRoundTripBusyPersistenceAndRotation(t *testing.T) {
	dir := t.TempDir()
	origin := "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
	saved := hostconfig.Defaults()
	saved.Port = unusedPort(t)
	saved.AllowedOrigins = []string{origin}
	if err := hostconfig.Save(dir, saved); err != nil {
		t.Fatal(err)
	}
	input, toHost := io.Pipe()
	fromHost, output := io.Pipe()
	t.Cleanup(func() { input.Close(); toHost.Close(); fromHost.Close(); output.Close() })
	finished := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	go func() { finished <- Run(ctx, input, output, origin, dir); output.Close() }()
	read := func() map[string]json.RawMessage {
		t.Helper()
		message, err := Read(fromHost)
		if err != nil {
			t.Fatal(err)
		}
		return message
	}
	ready := read()
	var base, key string
	json.Unmarshal(ready["base_url"], &base)
	json.Unmarshal(ready["api_key"], &key)
	if strings.Contains(string(ready["config"]), "allowed_origins") {
		t.Fatal("ready exposed protected settings")
	}
	writer := &Writer{Output: toHost}
	send := func(value any) {
		t.Helper()
		if err := writer.Send(value); err != nil {
			t.Fatal(err)
		}
	}
	rpc := func(kind, id string, settings any) map[string]json.RawMessage {
		t.Helper()
		request := map[string]any{"type": kind, "request_id": id}
		if settings != nil {
			request["config"] = settings
		}
		send(request)
		response := read()
		if string(response["request_id"]) != `"`+id+`"` {
			t.Fatal("RPC response ID changed")
		}
		return response
	}
	get := rpc("config_get", "get", nil)
	if string(get["type"]) != `"config"` || string(get["restart_required"]) != "false" {
		t.Fatal("initial settings response invalid")
	}
	occupied, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	if reply := rpc("config_set", "occupied-port", map[string]any{"port": occupied.Addr().(*net.TCPAddr).Port}); string(reply["type"]) != `"rpc_error"` {
		t.Fatal("occupied port accepted")
	}
	unchanged, err := hostconfig.Load(dir)
	if err != nil || unchanged.Port != saved.Port {
		t.Fatal("occupied port modified saved configuration")
	}
	updated := rpc("config_set", "set", map[string]any{"session_name": "Updated Session", "default_model": "configured-model", "thinking": "high", "online": true, "include_reasoning": false, "port": unusedPort(t)})
	if string(updated["type"]) != `"config"` || string(updated["restart_required"]) != "true" {
		t.Fatal("port update did not request restart")
	}
	loaded, err := hostconfig.Load(dir)
	if err != nil || loaded.SessionName != "Updated Session" || loaded.IncludeReasoning || !loaded.Online || loaded.AllowedOrigins[0] != origin {
		t.Fatalf("saved settings mismatch: %+v %v", loaded, err)
	}
	for _, invalid := range []any{map[string]any{"allowed_origins": []string{origin}}, map[string]any{"port": 0}, map[string]any{"include_reasoning": nil}} {
		if reply := rpc("config_set", "invalid", invalid); string(reply["type"]) != `"rpc_error"` {
			t.Fatal("invalid public settings accepted")
		}
	}
	send(map[string]any{"type": "status", "tabs": 1})
	response := make(chan *http.Response, 1)
	errors := make(chan error, 1)
	go func() {
		request, _ := http.NewRequest("GET", base+"/models", nil)
		request.Header.Set("Authorization", "Bearer "+key)
		result, err := http.DefaultClient.Do(request)
		if err != nil {
			errors <- err
		} else {
			response <- result
		}
	}()
	job := read()
	var id string
	json.Unmarshal(job["job"], &id)
	if string(job["type"]) != `"req"` {
		t.Fatal("catalog was not forwarded")
	}
	if reply := rpc("config_get", "busy-get", nil); string(reply["type"]) != `"config"` {
		t.Fatal("reading settings while busy failed")
	}
	if reply := rpc("config_set", "busy-set", map[string]any{"thinking": "low"}); string(reply["type"]) != `"rpc_error"` {
		t.Fatal("changed settings while busy")
	}
	if reply := rpc("rotate_key", "busy-key", nil); string(reply["type"]) != `"rpc_error"` {
		t.Fatal("rotated key while busy")
	}
	send(map[string]any{"type": "evt", "evt": map[string]any{"job": id, "kind": "result", "result": map[string]any{"code": 0, "data": map[string]any{"models": []string{"configured-model"}}}}})
	send(map[string]any{"type": "evt", "evt": map[string]any{"job": id, "kind": "done"}})
	select {
	case result := <-response:
		io.Copy(io.Discard, result.Body)
		result.Body.Close()
		if result.StatusCode != 200 {
			t.Fatal("old listener stopped after port setting changed")
		}
	case err := <-errors:
		t.Fatal(err)
	case <-time.After(3 * time.Second):
		t.Fatal("catalog did not finish")
	}
	configPath := filepath.Join(dir, "config.json")
	if err := os.Rename(configPath, configPath+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(configPath, 0700); err != nil {
		t.Fatal(err)
	}
	if reply := rpc("config_set", "save-failure", map[string]any{"thinking": "low"}); string(reply["type"]) != `"rpc_error"` {
		t.Fatal("failed disk write reported success")
	}
	afterFailure := rpc("config_get", "after-failure", nil)
	var settings hostconfig.Settings
	json.Unmarshal(afterFailure["config"], &settings)
	if settings.Thinking != "high" {
		t.Fatal("failed save changed live settings")
	}
	if err := os.Remove(configPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(configPath+".saved", configPath); err != nil {
		t.Fatal(err)
	}
	rotated := rpc("rotate_key", "rotate", nil)
	var newKey string
	json.Unmarshal(rotated["api_key"], &newKey)
	if string(rotated["type"]) != `"key"` || len(newKey) < 24 || newKey == key {
		t.Fatal("API key did not rotate")
	}
	onDisk, err := ClientKey(dir)
	if err != nil || onDisk != newKey {
		t.Fatal("API key rotation was not persisted")
	}
	checkAuth := func(key string, want int) {
		t.Helper()
		request, _ := http.NewRequest("POST", base+"/chat/completions", strings.NewReader(`{}`))
		request.Header.Set("Authorization", "Bearer "+key)
		result, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, result.Body)
		result.Body.Close()
		if result.StatusCode != want {
			t.Fatalf("unexpected key authorization status %d", result.StatusCode)
		}
	}
	checkAuth(key, 401)
	checkAuth(newKey, 400)
	keyPath := filepath.Join(dir, "api-key.txt")
	if err := os.Rename(keyPath, keyPath+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(keyPath, 0700); err != nil {
		t.Fatal(err)
	}
	if reply := rpc("rotate_key", "rotation-failure", nil); string(reply["type"]) != `"rpc_error"` {
		t.Fatal("failed key persistence reported success")
	}
	checkAuth(newKey, 400)
	if err := os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(keyPath+".saved", keyPath); err != nil {
		t.Fatal(err)
	}
	if reply := rpc("config_set", "restore-port", map[string]any{"port": saved.Port}); string(reply["restart_required"]) != "false" {
		t.Fatal("restoring active port still requires restart")
	}
	toHost.Close()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("host did not exit")
	}
}

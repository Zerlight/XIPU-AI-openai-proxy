package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestDefaultsAndExplicitFalseSurvivePersistence(t *testing.T) {
	dir := t.TempDir()
	origin := "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"allowed_origins":["`+origin+`"]}`), 0600); err != nil {
		t.Fatal(err)
	}
	value, err := Load(dir)
	if err != nil || !value.IncludeReasoning || value.OmitHistoricalImages || value.Thinking != "minimal" || value.SessionName != "XIPU AI Bridge" {
		t.Fatalf("incorrect defaults: %+v %v", value, err)
	}
	value.IncludeReasoning = false
	value.Online = false
	value.DefaultModel = "synthetic-model"
	value.OmitHistoricalImages = true
	if err := Save(dir, value); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(dir)
	if err != nil || !reflect.DeepEqual(loaded, value) {
		t.Fatalf("settings changed on disk: %+v %v", loaded, err)
	}
	data, err := json.Marshal(value.Settings)
	if err != nil || strings.Contains(string(data), "allowed_origins") {
		t.Fatal("public settings exposed extension origins")
	}
}

func TestRejectInvalidOrProtectedSettings(t *testing.T) {
	for _, raw := range []string{`{"allowed_origins":[]}`, `{"include_reasoning":null}`, `{"omit_historical_images":null}`, `{"omit_historical_images":1}`, `{"omit_historical_images":"true"}`, `{"online":1}`, `{"port":0}`, `{"port":65536}`, `{"thinking":"unlimited"}`, `{"session_name":" "}`, `{"default_model":"model\nname"}`, `{"chat_timeout_seconds":9}`, `{"model_timeout_seconds":121}`, `{"idle_timeout_seconds":301}`, `{"unknown":true}`, `null`} {
		if _, err := DecodeSettings([]byte(raw), Defaults().Settings); err == nil {
			t.Fatalf("accepted invalid settings %s", raw)
		}
	}
	current := Defaults().Settings
	current.Online = true
	current.OmitHistoricalImages = true
	updated, err := DecodeSettings([]byte(`{"include_reasoning":false}`), current)
	if err != nil || updated.IncludeReasoning || !updated.Online || !updated.OmitHistoricalImages {
		t.Fatal("omitted settings were reset")
	}
	updated, err = DecodeSettings([]byte(`{"omit_historical_images":false}`), updated)
	if err != nil || updated.OmitHistoricalImages {
		t.Fatal("explicit false did not disable historical image omission")
	}
}

func TestAtomicSaveFailureAndMissingFile(t *testing.T) {
	dir := t.TempDir()
	if _, err := Load(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing configuration error was lost: %v", err)
	}
	value := Defaults()
	value.AllowedOrigins = []string{"chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"}
	if err := Save(dir, value); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	invalid := value
	invalid.Port = 0
	if err := Save(dir, invalid); err == nil {
		t.Fatal("invalid save succeeded")
	}
	after, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	if string(before) != string(after) {
		t.Fatal("validation failure modified the saved settings")
	}
	if err := os.Rename(filepath.Join(dir, "config.json"), filepath.Join(dir, "original.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "config.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := Save(dir, value); err == nil {
		t.Fatal("saved over a directory")
	}
	entries, _ := filepath.Glob(filepath.Join(dir, ".settings-*"))
	if len(entries) != 0 {
		t.Fatal("temporary file left behind")
	}
}

// Package config validates and persists the native host settings.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

type Settings struct {
	SessionName          string `json:"session_name"`
	Port                 int    `json:"port"`
	DefaultModel         string `json:"default_model"`
	Thinking             string `json:"thinking"`
	Online               bool   `json:"online"`
	ChatTimeoutSeconds   int    `json:"chat_timeout_seconds"`
	ModelTimeoutSeconds  int    `json:"model_timeout_seconds"`
	IdleTimeoutSeconds   int    `json:"idle_timeout_seconds"`
	IncludeReasoning     bool   `json:"include_reasoning"`
	OmitHistoricalImages bool   `json:"omit_historical_images"`
}

type Config struct {
	Settings
	AllowedOrigins []string `json:"allowed_origins"`
}

func Defaults() Config {
	return Config{Settings: Settings{SessionName: "XIPU AI Bridge", Port: 8765, Thinking: "minimal", ChatTimeoutSeconds: 300, ModelTimeoutSeconds: 30, IdleTimeoutSeconds: 90, IncludeReasoning: true}}
}

func ConfigDir() (string, error) {
	if override := os.Getenv("XIPU_BRIDGE_CONFIG_DIR"); override != "" {
		return override, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "XIPU AI Bridge"), nil
}

func decode(data []byte, destination any) error {
	if !utf8.Valid(data) {
		return errors.New("configuration must be valid UTF-8")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields == nil {
		return errors.New("configuration must be a JSON object")
	}
	for key, value := range fields {
		if string(value) == "null" {
			return fmt.Errorf("configuration field %s cannot be null", key)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("configuration must contain one JSON object")
	}
	return nil
}

func DecodeSettings(data []byte, current Settings) (Settings, error) {
	if err := decode(data, &current); err != nil {
		return current, err
	}
	return current, ValidateSettings(current)
}

func Load(dir string) (Config, error) {
	result := Defaults()
	data, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return result, fmt.Errorf("read host configuration: %w", err)
	}
	if len(data) > 64<<10 {
		return result, errors.New("configuration exceeds 64 KiB")
	}
	if err := decode(data, &result); err != nil {
		return result, err
	}
	return result, Validate(result)
}

func ValidateSettings(settings Settings) error {
	validText := func(value string, required bool) bool {
		return (!required || value != "") && value == strings.TrimSpace(value) && utf8.RuneCountInString(value) <= 200 && strings.IndexFunc(value, unicode.IsControl) < 0
	}
	if !validText(settings.SessionName, true) {
		return errors.New("session_name must contain 1 to 200 characters on one trimmed line")
	}
	if !validText(settings.DefaultModel, false) {
		return errors.New("default_model must be empty or contain at most 200 characters on one trimmed line")
	}
	if settings.Port < 1 || settings.Port > 65535 {
		return errors.New("port must be between 1 and 65535")
	}
	switch settings.Thinking {
	case "minimal", "low", "medium", "high":
	default:
		return errors.New("thinking must be minimal, low, medium, or high")
	}
	if settings.ChatTimeoutSeconds < 10 || settings.ChatTimeoutSeconds > 1800 {
		return errors.New("chat_timeout_seconds must be between 10 and 1800")
	}
	if settings.ModelTimeoutSeconds < 5 || settings.ModelTimeoutSeconds > 120 {
		return errors.New("model_timeout_seconds must be between 5 and 120")
	}
	if settings.IdleTimeoutSeconds < 5 || settings.IdleTimeoutSeconds > 600 || settings.IdleTimeoutSeconds > settings.ChatTimeoutSeconds {
		return errors.New("idle_timeout_seconds must be between 5 and 600 and cannot exceed the chat timeout")
	}
	return nil
}

func Validate(value Config) error {
	if err := ValidateSettings(value.Settings); err != nil {
		return err
	}
	if len(value.AllowedOrigins) == 0 {
		return errors.New("configuration requires an allowed extension origin")
	}
	pattern := regexp.MustCompile(`^chrome-extension://[a-p]{32}/$`)
	for _, origin := range value.AllowedOrigins {
		if !pattern.MatchString(origin) {
			return errors.New("configuration contains an invalid extension origin")
		}
	}
	return nil
}

func Save(dir string, value Config) error {
	if err := Validate(value); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return AtomicWrite(filepath.Join(dir, "config.json"), append(data, '\n'), 0600)
}

// AtomicWrite writes a temporary file before replacement. Rename is atomic on
// Unix; Go does not guarantee atomic replacement on other platforms.
func AtomicWrite(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	for _, candidate := range []string{dir, path} {
		info, err := os.Lstat(candidate)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return errors.New("refusing a symbolic link in a settings path")
		}
		if err == nil && candidate == path && !info.Mode().IsRegular() {
			return errors.New("settings destination must be a regular file")
		}
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".settings-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := file.Chmod(mode); err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

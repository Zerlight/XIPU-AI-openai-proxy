package native

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

func newKey() (string, error) {
	var entropy [32]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(entropy[:]), nil
}

func ClientKey(dir string) (string, error) {
	path := filepath.Join(dir, "api-key.txt")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err == nil {
		key, keyErr := newKey()
		if keyErr == nil {
			_, keyErr = file.WriteString(key + "\n")
		}
		closeErr := file.Close()
		if keyErr != nil {
			os.Remove(path)
			return "", keyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
	} else if !errors.Is(err, os.ErrExist) {
		return "", err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("local API key must be a regular file")
	}
	if err := os.Chmod(path, 0600); err != nil {
		return "", err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	key := strings.TrimSpace(string(body))
	if len(key) < 24 || len(key) > 256 || strings.ContainsAny(key, " \t\r\n") {
		return "", errors.New("invalid local API key file")
	}
	return key, nil
}

func RotateKey(dir string) (string, error) {
	key, err := newKey()
	if err != nil {
		return "", err
	}
	if err := config.AtomicWrite(filepath.Join(dir, "api-key.txt"), []byte(key+"\n"), 0600); err != nil {
		return "", err
	}
	return key, nil
}

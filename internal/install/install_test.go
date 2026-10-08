package install

import (
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

const testID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func testEnvironment(t *testing.T, goos string) environment {
	t.Helper()
	root := t.TempDir()
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(root, "downloaded-bridge")
	if err := os.WriteFile(exe, []byte("synthetic executable"), 0o700); err != nil {
		t.Fatal(err)
	}
	return environment{goos: goos, home: filepath.Join(root, "home"), configBase: filepath.Join(root, "config"), executable: exe, output: &bytes.Buffer{}, registry: func(...string) ([]byte, error) { t.Fatal("unexpected registry invocation"); return nil, nil }}
}

func installOptions(t *testing.T, extra ...string) options {
	t.Helper()
	o, err := parse(append([]string{"install", "--extension-id", testID}, extra...))
	if err != nil {
		t.Fatal(err)
	}
	return o
}

func TestInvalidArguments(t *testing.T) {
	for _, args := range [][]string{
		nil, {"unknown"}, {"install", "--extension-id", ""}, {"install", "--extension-id="},
		{"install", "--extension-id", "../escape"},
		{"install", "--extension-id", strings.Repeat("q", 32)},
		{"install", "--extension-id", testID, "--port", "0"},
		{"install", "--extension-id", testID, "--port", "65536"},
		{"install", "--extension-id", testID, "--session-name", " "},
		{"install", "--extension-id", testID, "--session-name", "bad\nname"},
		{"install", "--extension-id", testID, "--browser", "../../other"},
		{"uninstall", "--extension-id", testID}, {"uninstall", "extra"},
	} {
		if _, err := parse(args); err == nil {
			t.Errorf("accepted invalid arguments: %q", args)
		}
	}
}

func TestHelp(t *testing.T) {
	for _, command := range []string{"install", "uninstall"} {
		if _, err := parse([]string{command, "--help"}); !errors.Is(err, flag.ErrHelp) {
			t.Fatalf("help not recognized: %v", err)
		}
	}
}

func TestFreshInstallOrigins(t *testing.T) {
	for _, test := range []struct {
		name string
		args []string
		id   string
	}{
		{"official", []string{"install"}, "eegmaembfjajhifjbddmdbppchinmmcg"},
		{"custom", []string{"install", "--extension-id", testID}, testID},
	} {
		t.Run(test.name, func(t *testing.T) {
			env := testEnvironment(t, "linux")
			o, err := parse(test.args)
			if err != nil {
				t.Fatal(err)
			}
			if err := execute(o, env); err != nil {
				t.Fatal(err)
			}
			p, err := paths(o, env)
			if err != nil {
				t.Fatal(err)
			}
			cfg, err := config.Load(p.dir)
			if err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(p.manifest)
			if err != nil {
				t.Fatal(err)
			}
			var manifest hostManifest
			if err := json.Unmarshal(data, &manifest); err != nil {
				t.Fatal(err)
			}
			want := []string{"chrome-extension://" + test.id + "/"}
			if !reflect.DeepEqual(cfg.AllowedOrigins, want) || !reflect.DeepEqual(manifest.AllowedOrigins, want) {
				t.Fatalf("unexpected authorized origins: config %v, manifest %v; want %v", cfg.AllowedOrigins, manifest.AllowedOrigins, want)
			}
		})
	}
}

func TestStoreIdentityMatchesManifest(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "extension", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	der, err := base64.StdEncoding.DecodeString(manifest.Key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := x509.ParsePKIXPublicKey(der); err != nil {
		t.Fatalf("invalid manifest public key: %v", err)
	}
	hash := sha256.Sum256(der)
	id := make([]byte, 32)
	for index, value := range hash[:16] {
		id[index*2] = 'a' + (value >> 4)
		id[index*2+1] = 'a' + (value & 15)
	}
	if string(id) != officialExtensionID {
		t.Fatalf("manifest extension ID %s differs from installer default %s", id, officialExtensionID)
	}
}

func TestPlatformLayouts(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		for _, browser := range []string{"chrome", "edge", "chromium"} {
			t.Run(goos+"/"+browser, func(t *testing.T) {
				env := testEnvironment(t, goos)
				p, err := paths(installOptions(t, "--browser", browser), env)
				if err != nil {
					t.Fatal(err)
				}
				if !filepath.IsAbs(p.binary) || !filepath.IsAbs(p.manifest) || filepath.Base(p.manifest) != hostName+".json" {
					t.Fatalf("invalid layout: %+v", p)
				}
				if (p.registry != "") != (goos == "windows") {
					t.Fatalf("registry mismatch: %+v", p)
				}
				if goos == "windows" && !strings.HasSuffix(p.binary, ".exe") {
					t.Fatal("Windows binary missing extension")
				}
			})
		}
	}
	if _, err := paths(installOptions(t), testEnvironment(t, "android")); err == nil {
		t.Fatal("accepted unsupported OS")
	}
}

func TestDryRunNeverMutates(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		t.Run(goos, func(t *testing.T) {
			env := testEnvironment(t, goos)
			if err := execute(installOptions(t, "--dry-run"), env); err != nil {
				t.Fatal(err)
			}
			output := env.output.(*bytes.Buffer).String()
			if !strings.Contains(output, "Extension ID: "+testID+"\n") || !strings.Contains(output, "Allowed origins: chrome-extension://"+testID+"/\n") {
				t.Fatalf("dry-run did not identify the authorized extension: %s", output)
			}
			u, _ := parse([]string{"uninstall", "--dry-run"})
			if err := execute(u, env); err != nil {
				t.Fatal(err)
			}
			for _, p := range []string{env.home, env.configBase} {
				if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("dry-run created %s", p)
				}
			}
		})
	}
}

func TestInstallUpdateAndUninstallPreserveKey(t *testing.T) {
	env := testEnvironment(t, "linux")
	o := installOptions(t, "--session-name", "Bridge custom", "--port", "8766")
	if err := execute(o, env); err != nil {
		t.Fatal(err)
	}
	p, _ := paths(o, env)
	cfg, err := config.Load(p.dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg.DefaultModel = "synthetic-model"
	cfg.Thinking = "high"
	cfg.Online = true
	cfg.ChatTimeoutSeconds = 300
	cfg.ModelTimeoutSeconds = 60
	cfg.IdleTimeoutSeconds = 90
	cfg.IncludeReasoning = false
	if err := config.Save(p.dir, cfg); err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(p.dir, "api-key.txt")
	key := []byte("synthetic-key-for-tests-only")
	if err := os.WriteFile(keyPath, key, 0o600); err != nil {
		t.Fatal(err)
	}
	second, _ := parse([]string{"install", "--extension-id", strings.Repeat("b", 32), "--browser", "edge"})
	if err := execute(second, env); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p.config)
	var c config.Config
	if err := json.Unmarshal(data, &c); err != nil {
		t.Fatal(err)
	}
	if c.Settings != cfg.Settings || len(c.AllowedOrigins) != 2 {
		t.Fatalf("configuration lost on update: %+v", c)
	}
	if err := execute(installOptions(t, "--session-name", "Bridge new", "--port", "9876"), env); err != nil {
		t.Fatal(err)
	}
	c, err = config.Load(p.dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg.SessionName, cfg.Port = "Bridge new", 9876
	if c.Settings != cfg.Settings || len(c.AllowedOrigins) != 2 {
		t.Fatalf("explicit overrides changed unrelated settings: %+v", c)
	}
	data, _ = os.ReadFile(p.manifest)
	var m hostManifest
	if err := json.Unmarshal(data, &m); err != nil || m.Path != p.binary || m.Type != "stdio" {
		t.Fatalf("manifest does not point directly to executable: %s", data)
	}
	if runtime.GOOS != "windows" {
		for file, mode := range map[string]os.FileMode{p.binary: 0o700, p.config: 0o600, p.manifest: 0o600} {
			info, err := os.Stat(file)
			if err != nil || info.Mode().Perm() != mode {
				t.Fatalf("incorrect mode on %s", file)
			}
		}
	}
	u, _ := parse([]string{"uninstall"})
	if err := execute(u, env); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p.manifest); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("browser manifest was not removed")
	}
	for _, file := range []string{p.config, p.binary, keyPath} {
		if _, err := os.Stat(file); err != nil {
			t.Fatalf("shared file removed: %s", file)
		}
	}
	gotKey, _ := os.ReadFile(keyPath)
	if !bytes.Equal(gotKey, key) {
		t.Fatal("API key changed")
	}
	if err := execute(u, env); err != nil {
		t.Fatalf("repeated uninstall failed: %v", err)
	}
}

func TestRefusesForeignManifest(t *testing.T) {
	env := testEnvironment(t, "linux")
	o := installOptions(t)
	p, _ := paths(o, env)
	foreign := hostManifest{Name: hostName, Path: "/another/installation"}
	if err := writeJSON(p.manifest, foreign); err != nil {
		t.Fatal(err)
	}
	if err := execute(o, env); err == nil {
		t.Fatal("overwrote foreign registration")
	}
	u, _ := parse([]string{"uninstall"})
	if err := execute(u, env); err == nil {
		t.Fatal("removed foreign registration")
	}
}

func TestWindowsRegistryCommands(t *testing.T) {
	env := testEnvironment(t, "windows")
	o := installOptions(t, "--browser", "edge")
	p, _ := paths(o, env)
	var calls [][]string
	env.registry = func(args ...string) ([]byte, error) {
		calls = append(calls, append([]string(nil), args...))
		if args[0] == "QUERY" {
			return nil, errors.New("not present")
		}
		return nil, nil
	}
	if err := execute(o, env); err != nil {
		t.Fatal(err)
	}
	want := []string{"ADD", p.registry, "/ve", "/t", "REG_SZ", "/d", p.manifest, "/f"}
	if len(calls) != 2 || !reflect.DeepEqual(calls[1], want) {
		t.Fatalf("unexpected registry operations: %v", calls)
	}
	env.registry = func(args ...string) ([]byte, error) {
		calls = append(calls, args)
		return []byte("    (Default)    REG_SZ    " + p.manifest + "\r\n"), nil
	}
	u, _ := parse([]string{"uninstall", "--browser", "edge"})
	if err := execute(u, env); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls[len(calls)-1], []string{"DELETE", p.registry, "/f"}) {
		t.Fatalf("unexpected delete: %v", calls)
	}
}

func TestRefusesSymlinkDestination(t *testing.T) {
	env := testEnvironment(t, "linux")
	o := installOptions(t)
	p, _ := paths(o, env)
	if err := makePrivateDir(p.dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(env.executable, p.binary); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := execute(o, env); err == nil {
		t.Fatal("followed destination symlink")
	}
	content, _ := os.ReadFile(env.executable)
	if string(content) != "synthetic executable" {
		t.Fatal("source changed")
	}
}

func TestRefusesSymlinkParent(t *testing.T) {
	env := testEnvironment(t, "linux")
	target := filepath.Join(filepath.Dir(env.executable), "elsewhere")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, env.configBase); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := execute(installOptions(t), env); err == nil {
		t.Fatal("followed symlinked parent")
	}
	contents, err := os.ReadDir(target)
	if err != nil || len(contents) != 0 {
		t.Fatal("modified symlink target")
	}
}

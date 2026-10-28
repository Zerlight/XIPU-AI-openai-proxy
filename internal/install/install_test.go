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
		{"install", "--prefix="}, {"uninstall", "--prefix", "relative"},
		{"install", "--prefix", "/bad\npath"}, {"install", "--prefix", "/bad\rpath"}, {"install", "--prefix", "/bad\x00path"},
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
				wantDir := filepath.Join(env.configBase, "XIPU AI Bridge")
				wantBinary := filepath.Join(wantDir, "xipu-bridge")
				if goos == "linux" {
					wantDir = filepath.Join(env.configBase, "xipu-ai-bridge")
					wantBinary = filepath.Join(env.home, ".local", "opt", "xipu-ai-bridge", "xipu-bridge")
				} else if goos == "windows" {
					wantBinary += ".exe"
				}
				if p.dir != wantDir || p.config != filepath.Join(wantDir, "config.json") || p.binary != wantBinary {
					t.Fatalf("unexpected program or config path: %+v", p)
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

func TestLinuxBrowserPaths(t *testing.T) {
	env := testEnvironment(t, "linux")
	root := filepath.Dir(env.executable)
	chromeConfig := filepath.Join(root, "browser config")
	userData := filepath.Join(root, "browser data")
	custom := filepath.Join(root, "custom hosts")
	for _, test := range []struct {
		name, browser, configHome, userDataDir, override, want string
	}{
		{"xdg", "chromium", "", "", "", filepath.Join(env.configBase, "chromium", "NativeMessagingHosts")},
		{"chrome config", "chrome", chromeConfig, "", "", filepath.Join(chromeConfig, "google-chrome", "NativeMessagingHosts")},
		{"chromium config", "chromium", chromeConfig, "", "", filepath.Join(chromeConfig, "chromium", "NativeMessagingHosts")},
		{"user data precedence", "chromium", chromeConfig, userData, "", filepath.Join(userData, "NativeMessagingHosts")},
		{"explicit precedence", "chromium", "relative-config", "relative-data", custom, custom},
		{"brave xdg", "brave", chromeConfig, userData, "", filepath.Join(env.configBase, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")},
		{"brave explicit", "brave", chromeConfig, userData, custom, custom},
		{"edge unchanged", "edge", chromeConfig, userData, "", filepath.Join(env.configBase, "microsoft-edge", "NativeMessagingHosts")},
	} {
		t.Run(test.name, func(t *testing.T) {
			env.chromeConfigHome, env.chromeUserDataDir = test.configHome, test.userDataDir
			o := installOptions(t, "--browser", test.browser, "--native-host-dir", test.override)
			p, err := paths(o, env)
			if err != nil {
				t.Fatal(err)
			}
			if p.manifest != filepath.Join(test.want, hostName+".json") || p.dir != filepath.Join(env.configBase, "xipu-ai-bridge") {
				t.Fatalf("incorrect browser or host directory: %+v", p)
			}
		})
	}
}

func TestNativeHostDirectoryValidation(t *testing.T) {
	for _, test := range []struct{ goos, browser, override, configHome, userData string }{
		{"linux", "chromium", "relative", "", ""},
		{"linux", "chromium", "/path\nwith-newline", "", ""},
		{"linux", "chromium", "", "relative", ""},
		{"linux", "chromium", "", "", "relative"},
		{"windows", "chrome", "/custom", "", ""},
		{"darwin", "brave", "", "", ""},
		{"windows", "brave", "", "", ""},
	} {
		env := testEnvironment(t, test.goos)
		env.chromeConfigHome, env.chromeUserDataDir = test.configHome, test.userData
		o := installOptions(t, "--browser", test.browser, "--native-host-dir", test.override)
		if err := execute(o, env); err == nil {
			t.Fatalf("accepted unsupported path: %+v", test)
		}
		if _, err := os.Stat(env.configBase); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("invalid path mutated configuration")
		}
	}
}

func TestCustomNativeHostDirectoryLifecycle(t *testing.T) {
	for _, goos := range []string{"linux", "darwin"} {
		t.Run(goos, func(t *testing.T) {
			env := testEnvironment(t, goos)
			dir := filepath.Join(filepath.Dir(env.executable), "Browser data", "NativeMessagingHosts")
			o := installOptions(t, "--browser", "chromium", "--native-host-dir", dir, "--dry-run")
			if err := execute(o, env); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("dry-run created manifest directory")
			}
			o.dryRun = false
			if err := execute(o, env); err != nil {
				t.Fatal(err)
			}
			p, _ := paths(o, env)
			if _, err := os.Stat(filepath.Join(dir, hostName+".json")); err != nil {
				t.Fatal(err)
			}
			u, err := parse([]string{"uninstall", "--browser", "chromium", "--native-host-dir", dir})
			if err != nil {
				t.Fatal(err)
			}
			if err := execute(u, env); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(p.manifest); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("custom manifest was not removed")
			}
			if _, err := os.Stat(p.config); err != nil {
				t.Fatal("shared configuration was removed")
			}
			if err := os.Symlink(env.executable, p.manifest); err != nil {
				t.Skipf("symlinks unavailable: %v", err)
			}
			if execute(o, env) == nil || execute(u, env) == nil {
				t.Fatal("modified a managed manifest symlink")
			}
		})
	}
}

func TestInstallUpdateAndUninstallPreserveKey(t *testing.T) {
	for _, name := range []string{"default", "custom prefix"} {
		t.Run(name, func(t *testing.T) {
			env := testEnvironment(t, "linux")
			var extra []string
			if name == "custom prefix" {
				extra = []string{"--prefix", filepath.Join(filepath.Dir(env.executable), "Program files")}
			}
			o := installOptions(t, append([]string{"--session-name", "Bridge custom", "--port", "8766", "--dry-run"}, extra...)...)
			p, _ := paths(o, env)
			if len(extra) != 0 && p.binary != filepath.Join(extra[1], "xipu-ai-bridge", "xipu-bridge") {
				t.Fatalf("incorrect prefix destination: %s", p.binary)
			}
			if p.dir != filepath.Join(env.configBase, "xipu-ai-bridge") || p.manifest != filepath.Join(env.configBase, "google-chrome", "NativeMessagingHosts", hostName+".json") {
				t.Fatalf("program prefix changed configuration or registration: %+v", p)
			}
			if err := execute(o, env); err != nil {
				t.Fatal(err)
			}
			for _, dir := range []string{env.home, env.configBase, filepath.Dir(p.binary)} {
				if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("dry-run created %s", dir)
				}
			}
			if len(extra) != 0 {
				if err := os.Mkdir(extra[1], 0o755); err != nil {
					t.Fatal(err)
				}
			}
			o.dryRun = false
			if err := execute(o, env); err != nil {
				t.Fatal(err)
			}
			if len(extra) != 0 && runtime.GOOS != "windows" {
				info, err := os.Stat(extra[1])
				if err != nil || info.Mode().Perm() != 0o755 {
					t.Fatal("installer changed prefix permissions")
				}
			}
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
			second, _ := parse(append([]string{"install", "--extension-id", strings.Repeat("b", 32), "--browser", "edge"}, extra...))
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
			if err := execute(installOptions(t, append([]string{"--session-name", "Bridge new", "--port", "9876"}, extra...)...), env); err != nil {
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
			u, _ := parse(append([]string{"uninstall"}, extra...))
			if len(extra) != 0 {
				wrong, _ := parse([]string{"uninstall"})
				if execute(wrong, env) == nil || execute(installOptions(t), env) == nil {
					t.Fatal("modified a registration belonging to a different prefix")
				}
			}
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
		})
	}
}

func TestPrefixRequiresLinux(t *testing.T) {
	for _, goos := range []string{"darwin", "windows"} {
		env := testEnvironment(t, goos)
		prefix := filepath.Join(filepath.Dir(env.executable), "programs")
		for _, action := range []string{"install", "uninstall"} {
			o, err := parse([]string{action, "--prefix", prefix})
			if err != nil {
				t.Fatal(err)
			}
			if err := execute(o, env); err == nil || !strings.Contains(err.Error(), "--prefix is supported only on Linux") {
				t.Fatalf("accepted prefix on %s: %v", goos, err)
			}
		}
		for _, dir := range []string{prefix, env.configBase, env.home} {
			if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("unsupported prefix created %s", dir)
			}
		}
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
	if err := makePrivateDir(filepath.Dir(p.binary)); err != nil {
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
	for _, name := range []string{"config", "prefix"} {
		t.Run(name, func(t *testing.T) {
			env := testEnvironment(t, "linux")
			o := installOptions(t)
			link := env.configBase
			if name == "prefix" {
				link = filepath.Join(filepath.Dir(env.executable), "programs")
				o = installOptions(t, "--prefix", link)
			}
			target := filepath.Join(filepath.Dir(env.executable), "elsewhere")
			if err := os.Mkdir(target, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, link); err != nil {
				t.Skipf("symlinks unavailable: %v", err)
			}
			if err := execute(o, env); err == nil {
				t.Fatal("followed symlinked parent")
			}
			contents, err := os.ReadDir(target)
			if err != nil || len(contents) != 0 {
				t.Fatal("modified symlink target")
			}
		})
	}
}

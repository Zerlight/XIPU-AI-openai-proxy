// Package install registers a per-user Native Messaging host without a runtime dependency.
package install

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

const hostName = "edu.xjtlu.xipu_bridge"
const officialExtensionID = "eegmaembfjajhifjbddmdbppchinmmcg"

var extensionID = regexp.MustCompile(`^[a-p]{32}$`)

type hostManifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

type options struct {
	action, browser, id, session string
	port                         int
	dryRun, sessionSet, portSet  bool
}

type environment struct {
	goos, home, configBase, executable string
	output                             io.Writer
	registry                           func(...string) ([]byte, error)
}

type layout struct {
	dir, binary, config, manifest, registry string
}

// Run accepts the install or uninstall subcommand followed by flags.
// Uninstall removes one browser's registration and preserves shared settings and keys.
func Run(args []string) error {
	opts, err := parse(args)
	if errors.Is(err, flag.ErrHelp) {
		fmt.Fprint(os.Stdout, usage)
		return nil
	}
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	return execute(opts, environment{runtime.GOOS, home, base, executable, os.Stdout,
		func(args ...string) ([]byte, error) { return exec.Command("reg.exe", args...).CombinedOutput() }})
}

const usage = `Usage:
  xipu-bridge install [--extension-id ID] [--browser chrome|edge|chromium]
      [--session-name NAME] [--port 8765] [--dry-run]
  xipu-bridge uninstall [--browser chrome|edge|chromium] [--dry-run]

Install copies this executable and registers a per-user Native Messaging host.
The default extension ID is ` + officialExtensionID + `.
Use --extension-id to register a custom build instead.
Existing settings and API key are preserved unless explicitly changed.
The default session is "XIPU AI Bridge".
Uninstall removes the selected browser registration; shared files are preserved.
Dry-run does not write files or invoke registry commands.
`

func parse(args []string) (options, error) {
	var o options
	if len(args) == 0 || (args[0] != "install" && args[0] != "uninstall") {
		return o, errors.New("expected install or uninstall subcommand")
	}
	o.action = args[0]
	fs := flag.NewFlagSet(o.action, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&o.browser, "browser", "chrome", "chrome, edge, or chromium")
	fs.BoolVar(&o.dryRun, "dry-run", false, "describe changes without writing files or registry entries")
	if o.action == "install" {
		defaults := config.Defaults()
		fs.StringVar(&o.id, "extension-id", officialExtensionID, "32-character extension ID for a custom build")
		fs.StringVar(&o.session, "session-name", defaults.SessionName, "dedicated school conversation")
		fs.IntVar(&o.port, "port", defaults.Port, "local API port")
	}
	if err := fs.Parse(args[1:]); err != nil {
		return o, err
	}
	if fs.NArg() != 0 {
		return o, errors.New("unexpected positional arguments")
	}
	fs.Visit(func(f *flag.Flag) {
		o.sessionSet = o.sessionSet || f.Name == "session-name"
		o.portSet = o.portSet || f.Name == "port"
	})
	if o.browser != "chrome" && o.browser != "edge" && o.browser != "chromium" {
		return o, errors.New("--browser must be chrome, edge, or chromium")
	}
	if o.action == "install" {
		if !extensionID.MatchString(o.id) {
			return o, errors.New("--extension-id must contain exactly 32 lowercase letters from a through p")
		}
		o.session = strings.TrimSpace(o.session)
		if o.session == "" || strings.ContainsAny(o.session, "\x00\r\n") {
			return o, errors.New("--session-name must be a nonempty single line")
		}
		if o.port < 1 || o.port > 65535 {
			return o, errors.New("--port must be between 1 and 65535")
		}
	}
	return o, nil
}

func paths(o options, env environment) (layout, error) {
	p := layout{dir: filepath.Join(env.configBase, "XIPU AI Bridge")}
	if !filepath.IsAbs(env.configBase) || !filepath.IsAbs(env.home) {
		return p, errors.New("user home and configuration paths must be absolute")
	}
	p.binary = filepath.Join(p.dir, "xipu-bridge")
	p.config = filepath.Join(p.dir, "config.json")
	var manifestDir string
	switch env.goos {
	case "darwin":
		name := map[string]string{"chrome": "Google/Chrome", "edge": "Microsoft Edge", "chromium": "Chromium"}[o.browser]
		manifestDir = filepath.Join(env.home, "Library", "Application Support", filepath.FromSlash(name), "NativeMessagingHosts")
	case "linux":
		name := map[string]string{"chrome": "google-chrome", "edge": "microsoft-edge", "chromium": "chromium"}[o.browser]
		manifestDir = filepath.Join(env.configBase, name, "NativeMessagingHosts")
	case "windows":
		p.binary += ".exe"
		manifestDir = filepath.Join(p.dir, "manifests", o.browser)
		name := map[string]string{"chrome": `Google\Chrome`, "edge": `Microsoft\Edge`, "chromium": "Chromium"}[o.browser]
		p.registry = `HKCU\Software\` + name + `\NativeMessagingHosts\` + hostName
	default:
		return p, fmt.Errorf("unsupported operating system: %s", env.goos)
	}
	p.manifest = filepath.Join(manifestDir, hostName+".json")
	return p, nil
}

func execute(o options, env environment) error {
	p, err := paths(o, env)
	if err != nil {
		return err
	}
	if err := checkManifest(p); err != nil {
		return err
	}
	if o.action == "uninstall" {
		if o.dryRun {
			fmt.Fprintf(env.output, "Would unregister %s from %s\nWould remove %s\nShared runtime, configuration, and API key would be preserved.\n", hostName, o.browser, p.manifest)
			return nil
		}
		if p.registry != "" {
			// Refuse to delete a registration owned by another installation.
			data, err := queryOwnRegistration(env, p)
			if err != nil {
				return fmt.Errorf("cannot inspect registration (it may already be absent): %w", err)
			}
			if !hasRegistryValue(data) {
				return errors.New("refusing to remove a registration owned by another installation")
			}
			if _, err := env.registry("DELETE", p.registry, "/f"); err != nil {
				return fmt.Errorf("remove browser registration: %w", err)
			}
		}
		if err := os.Remove(p.manifest); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		fmt.Fprintf(env.output, "Unregistered %s from %s. Shared runtime, configuration, and API key were preserved.\n", hostName, o.browser)
		return nil
	}
	cfg, err := mergedConfig(o, p.config)
	if err != nil {
		return err
	}
	manifest := hostManifest{hostName, "XIPU AI Bridge local OpenAI-compatible endpoint", p.binary, "stdio", cfg.AllowedOrigins}
	if o.dryRun {
		fmt.Fprintf(env.output, "Would copy executable to %s\nWould write %s\nWould register %s\nExtension ID: %s\nAllowed origins: %s\nSession: %s\nPort: %d\nExisting API key would be preserved.\n", p.binary, p.config, p.manifest, o.id, strings.Join(cfg.AllowedOrigins, ", "), cfg.SessionName, cfg.Port)
		if p.registry != "" {
			fmt.Fprintf(env.output, "Would set registry key %s to %s\n", p.registry, p.manifest)
		}
		return nil
	}
	if p.registry != "" {
		if _, err := env.registry("QUERY", p.registry, "/ve"); err == nil {
			data, err := queryOwnRegistration(env, p)
			if err != nil || !hasRegistryValue(data) {
				return errors.New("refusing to replace a registration owned by another installation")
			}
		}
	}
	if err := makePrivateDir(p.dir); err != nil {
		return err
	}
	if err := copyExecutable(env.executable, p.binary); err != nil {
		return fmt.Errorf("install executable (close browsers before upgrading): %w", err)
	}
	if err := config.Save(p.dir, cfg); err != nil {
		return err
	}
	if err := writeJSON(p.manifest, manifest); err != nil {
		return err
	}
	if p.registry != "" {
		if _, err := env.registry("ADD", p.registry, "/ve", "/t", "REG_SZ", "/d", p.manifest, "/f"); err != nil {
			return fmt.Errorf("register native host: %w", err)
		}
	}
	fmt.Fprintf(env.output, "Installed %s\nRegistered %s for %s\nOpen the extension popup and connect. Keep a school chat tab signed in.\n", p.binary, hostName, o.browser)
	return nil
}

func queryOwnRegistration(env environment, p layout) ([]byte, error) {
	// reg.exe performs the Unicode path comparison itself; parsing its localized
	// console encoding would miscompare paths containing non-ASCII characters.
	return env.registry("QUERY", p.registry, "/ve", "/f", p.manifest, "/d", "/e", "/t", "REG_SZ")
}

func hasRegistryValue(data []byte) bool {
	// The type marker is ASCII even with localized output. Removing NULs also
	// handles UTF-16 output, without needing to decode the path or value name.
	return strings.Contains(strings.ReplaceAll(string(data), "\x00", ""), "REG_SZ")
}

func mergedConfig(o options, path string) (config.Config, error) {
	c := config.Defaults()
	if err := rejectSymlink(path); err != nil {
		return c, err
	}
	c, err := config.Load(filepath.Dir(path))
	if errors.Is(err, os.ErrNotExist) {
		c = config.Defaults()
	} else if err != nil {
		return c, err
	}
	if o.sessionSet {
		c.SessionName = o.session
	}
	if o.portSet {
		c.Port = o.port
	}
	origins := map[string]bool{"chrome-extension://" + o.id + "/": true}
	for _, origin := range c.AllowedOrigins {
		origins[origin] = true
	}
	c.AllowedOrigins = nil
	for origin := range origins {
		c.AllowedOrigins = append(c.AllowedOrigins, origin)
	}
	sort.Strings(c.AllowedOrigins)
	return c, config.Validate(c)
}

func checkManifest(p layout) error {
	if err := rejectSymlink(p.manifest); err != nil {
		return err
	}
	data, err := os.ReadFile(p.manifest)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var m hostManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return fmt.Errorf("existing host manifest is invalid: %w", err)
	}
	if m.Name != hostName || m.Path != p.binary {
		return errors.New("refusing to replace or remove a host from another installation")
	}
	return nil
}

func rejectSymlink(path string) error {
	for {
		info, err := os.Lstat(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing symbolic link in installation path: %s", path)
		}
		parent := filepath.Dir(path)
		if parent == path {
			return nil
		}
		path = parent
	}
}

func makePrivateDir(path string) error {
	if err := rejectSymlink(path); err != nil {
		return err
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return os.Chmod(path, 0o700)
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, strings.NewReader(string(data)+"\n"), 0o600)
}

func copyExecutable(source, destination string) error {
	if err := rejectSymlink(destination); err != nil {
		return err
	}
	srcInfo, err := os.Stat(source)
	if err != nil {
		return err
	}
	if !srcInfo.Mode().IsRegular() {
		return errors.New("source executable is not a regular file")
	}
	if dstInfo, err := os.Stat(destination); err == nil && os.SameFile(srcInfo, dstInfo) {
		return nil
	}
	src, err := os.Open(source)
	if err != nil {
		return err
	}
	defer src.Close()
	return atomicWrite(destination, src, 0o700)
}

func atomicWrite(path string, src io.Reader, mode os.FileMode) error {
	if err := rejectSymlink(path); err != nil {
		return err
	}
	if err := makePrivateDir(filepath.Dir(path)); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".install-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err := f.Chmod(mode); err != nil {
		return err
	}
	if _, err := io.Copy(f, src); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

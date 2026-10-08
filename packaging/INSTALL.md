# Install XIPU AI Bridge

This package contains a standalone native host. No Go, Node.js, or Python
installation is required. Extract the complete archive before running it.

1. Choose the package for your operating system and CPU: `arm64` for Apple
   silicon/ARM64, or `amd64` for Intel/AMD x86-64. Close browsers before upgrading
   an existing native host.
2. Install for your user account; administrator access and `sudo` are not needed:
   - macOS: double-click `Install.command`.
   - Windows: double-click `Install.cmd`.
   - Linux: open a terminal in this folder and run `./install.sh`.
3. Install the XIPU AI Bridge browser extension separately. Its official ID is
   `eegmaembfjajhifjbddmdbppchinmmcg`. A native-host package does not install the
   extension. For unpacked development use, extract the separate extension ZIP
   into a permanent folder and load that folder with the browser's Developer
   mode. Keep it in place.
4. Open or refresh your signed-in XIPU AI tab, then open the extension popup and
   Settings. Select a dedicated conversation with the chosen model, an empty
   system prompt, and Context Count 0. Save, then copy the displayed base URL and
   local API key into your client.

Chrome is the default browser. For Edge or Chromium, run the launcher from a
terminal with `--browser edge` or `--browser chromium`. For example:

```text
macOS:   ./Install.command --browser edge
Windows: .\Install.cmd --browser edge
Linux:   ./install.sh --browser edge
```

All launcher arguments are passed to `xipu-bridge install`. Add `--dry-run` to
preview paths and allowed origins without changing files or registry entries.
Use `--extension-id ID` only for a custom extension build with a different ID.
Existing settings and the local API key are preserved. To see all options, run
`xipu-bridge install --help` (use `./xipu-bridge` on macOS/Linux or
`.\xipu-bridge.exe` on Windows).

The installer copies the host into your user configuration directory; this
extracted native package can then be removed. Chrome starts the installed host
automatically. Do not run it as a separate background service. Keep only one
browser/profile connected to the host at a time.

These are unsigned packages. macOS or Windows may block execution or display a
security warning. Follow the operating system's normal security controls; these
launchers do not bypass them. Downloading this package alone does not prove
publisher identity. Compare its SHA-256 hash against the release's `SHA256SUMS`.

If installation fails, read the visible error. A conflicting registration is
not overwritten. If the popup reports an immediate host exit, check for a port
conflict or an OS execution restriction. Refresh the school tab if it is not
connected.

To remove this browser's registration, run `./xipu-bridge uninstall --browser
chrome` on macOS/Linux, or `.\xipu-bridge.exe uninstall --browser chrome` on
Windows. Shared settings, the key, and the installed executable are preserved.
Remove the extension separately through the browser UI.

See the included `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `licenses/` for terms.

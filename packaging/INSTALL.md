# Install XIPU AI Bridge

The native host is a self-contained binary with no external runtime dependencies. It installs under your user account—do not run the installer with `sudo` or as Administrator.

1. Download the native package for your operating system and CPU architecture, along with `xipu-bridge-extension.zip`, from [GitHub Releases](https://github.com/Zerlight/XIPU-AI-openai-proxy/releases). Choose `arm64` for Apple silicon / ARM64 devices, or `amd64` for 64-bit Intel / AMD devices. Extract both archives and move the extension folder to a permanent location.
2. Run the installer inside the extracted native package folder:
   - **macOS:** Double-click `Install.command`.
   - **Windows:** Double-click `Install.cmd`.
   - **Linux:** Open a terminal in the folder and run `bash install.sh`.
3. In Chrome, open `chrome://extensions` and turn on **Developer mode**. Click **Load unpacked** and select the extracted extension folder containing `manifest.json`. Keep that folder in place.
4. Click **XIPU AI Bridge** in the browser toolbar and choose **Start setup** to open the setup guide. Sign in to XIPU AI, refresh the chat tab, and click **Load models**. Pick an initial model and a unique conversation name, then click **Create bridge session**. Setup creates and verifies the dedicated conversation and saves your local settings without sending any test prompts.
5. Copy the **Base URL** and **API key** into your client. You can select any available model directly in your client, and the bridge will switch the conversation's model automatically. Keep the XIPU AI tab open and signed in while making requests.

If you have already configured a session on this computer, click **Use existing setup** on the welcome screen to go straight to the dashboard. To use an existing conversation instead of creating a new one, open Settings and choose **Load from XIPU AI → Use session → Save changes**.

Model changes in the dedicated conversation persist across requests (including after a failed or cancelled request). Avoid manually editing or sending messages in that conversation while an API request is running.

Prebuilt binaries are not Developer ID or Authenticode signed, or Apple notarized. Your operating system may warn or block execution; follow its normal security controls.

On Linux, Chromium and Brave users should specify their browser when installing:
`bash install.sh --browser chromium` or `bash install.sh --browser brave`.

The Linux executable is installed at `~/.local/opt/xipu-ai-bridge/xipu-bridge`; configuration and the local API key are stored in `$XDG_CONFIG_HOME/xipu-ai-bridge` (default `~/.config/xipu-ai-bridge`). To change only the program location, use `bash install.sh --prefix "$HOME/Applications"`, which installs under `~/Applications/xipu-ai-bridge`. The Linux-only `--prefix` takes an absolute parent directory; use the same value when upgrading or running `./xipu-bridge uninstall`.

Pass `--dry-run` to preview the target paths without modifying any files. For custom browser profile locations on Linux or macOS, pass `--native-host-dir /absolute/path/to/NativeMessagingHosts` (and use the same flag when upgrading or uninstalling).

For Edge setup, upgrades, advanced settings, and troubleshooting, see the [reference guide](https://github.com/Zerlight/XIPU-AI-openai-proxy/blob/main/docs/reference.md).

See `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `licenses/` for licensing details.

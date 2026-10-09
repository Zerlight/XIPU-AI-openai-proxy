# Install XIPU AI Bridge

No additional language runtime is required. Installation is for your user
account; do not run the installer with `sudo` or as Administrator.

1. Download the native package for your operating system and CPU, plus
   `xipu-bridge-extension.zip`, from
   [GitHub Releases](https://github.com/Zerlight/XIPU-AI-openai-proxy/releases).
   Choose `arm64` for Apple silicon/ARM64, or `amd64` for Intel/AMD x86-64.
   Extract both archives completely. Keep the extension folder in a permanent
   location.
2. Run the native installer from its extracted folder:
   - macOS: double-click `Install.command`.
   - Windows: double-click `Install.cmd`.
   - Linux: open a terminal in this folder and run `bash install.sh`.
3. In Chrome, open `chrome://extensions` and enable **Developer mode**. Click
   **Load unpacked** and select the extracted extension folder containing
   `manifest.json`. Keep that folder in place.
4. Click **XIPU AI Bridge** in Chrome's toolbar or Extensions menu. Choose
   **Start setup** on the welcome screen to open the guide in a new tab.
   Sign in to XIPU AI and refresh the tab,
   then load the available models. Choose a model and a unique conversation name
   and click **Create bridge session**. Setup configures and verifies the new
   conversation and saves your local settings without generating a response.
5. Copy the base URL and API key into your client. Choose any available model;
   the bridge updates the school conversation automatically. Keep the XIPU AI
   tab signed in. You can reopen Setup from the dashboard or Settings.

For a previously configured connection, choose **Use existing setup** on the
welcome screen to open the dashboard. To select an existing dedicated
conversation, open Settings and use **Load from XIPU AI → Use session → Save
changes**.

Model changes persist, including after a failed or cancelled request. Do not
manually edit or send messages in the dedicated conversation while a request
is active.

The native binaries are unsigned, so your operating system may warn or block
execution. Follow its normal security controls.

For other browsers, upgrades, configuration, and troubleshooting, see the
[reference guide](https://github.com/Zerlight/XIPU-AI-openai-proxy/blob/main/docs/reference.md).

See the included `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `licenses/` for terms.

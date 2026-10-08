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
4. Sign in to XIPU AI and refresh the tab. Create a dedicated conversation named
   **XIPU AI Bridge** exclusively for the bridge. Leave its system prompt empty
   and set **Context Count** to **0**. Its initial model can be any available model.
5. Open the extension's **Settings** and click **Load from XIPU AI**. Select your
   conversation, then click **Use session** and **Save changes**. Copy the base
   URL and API key from the popup into your client. Choose any available model
   in the client; the bridge updates the school conversation automatically.
   Keep the XIPU AI tab signed in.

Model changes persist, including after a failed or cancelled request. Do not
manually edit or send messages in the dedicated conversation while a request
is active.

The native binaries are unsigned, so your operating system may warn or block
execution. Follow its normal security controls.

For other browsers, upgrades, configuration, and troubleshooting, see the
[reference guide](https://github.com/Zerlight/XIPU-AI-openai-proxy/blob/main/docs/reference.md).

See the included `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `licenses/` for terms.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design/logo/xipu-ai-bridge-lockup-dark.svg">
    <img src="design/logo/xipu-ai-bridge-lockup.svg" alt="XIPU AI Bridge" width="390" height="144">
  </picture>
</p>

<p align="center">Use XIPU AI with your OpenAI-compatible clients.</p>

<p align="center">
  <a href="https://github.com/Zerlight/XIPU-AI-openai-proxy/actions/workflows/ci.yml"><img src="https://github.com/Zerlight/XIPU-AI-openai-proxy/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-CC0_1.0-242424" alt="License: CC0 1.0"></a>
</p>

<p align="center">
  <a href="https://github.com/Zerlight/XIPU-AI-openai-proxy/releases">Downloads</a> ·
  <a href="#install">Install</a> ·
  <a href="docs/reference.md">Documentation</a> ·
  <a href="https://github.com/Zerlight/XIPU-AI-openai-proxy/issues">Report an issue</a>
</p>

XIPU AI Bridge connects your signed-in XIPU AI browser tab to local tools and apps. It pairs a browser extension with a small standalone binary to serve a local, authenticated OpenAI-compatible API on your machine.

- **Text, images, and documents** via Chat Completions and the Responses API, with streaming support.
- **Function calling and structured outputs** handled through structured prompts and local JSON Schema validation, while your client executes the tools.
- **Local control** over session isolation, request defaults, timeouts, and local API keys. Your XIPU AI credentials never leave the browser.
- **Self-contained packages** for macOS, Windows, and Linux with no external runtime dependencies.

> [!WARNING]
> **Disclaimer — account access and academic integrity**
>
> XIPU AI Bridge is an independent, unofficial project and is not affiliated with, endorsed by, or approved by Xi'an Jiaotong-Liverpool University (XJTLU), XIPU AI, or any model provider.
>
> You are responsible for ensuring your use complies with applicable laws, university policies, academic integrity rules, and service terms, including access and usage limits. **Unauthorized use, academic misconduct, or other violations may result in access restrictions, account suspension or termination, and disciplinary action affecting your academic standing.**
>
> This software is provided **"AS IS", without warranties of any kind**, to the fullest extent permitted by law. The authors and contributors are not liable for any losses, usage charges, account restrictions, disciplinary actions, or other damages arising from its use. Nothing in this notice excludes liability that cannot lawfully be excluded.
>
> The CC0 1.0 dedication applies only to this project's original code and documentation; it does not grant permission to access third-party services, bypass security controls, or disregard institutional rules.

## Install

### 1. Install the native host

From [Releases](https://github.com/Zerlight/XIPU-AI-openai-proxy/releases), download **both** the native package for your platform and **`xipu-bridge-extension.zip`**, then extract both archives. Choose `arm64` for Apple silicon or ARM64 devices, or `amd64` for 64-bit Intel/AMD devices.

Open the extracted native package folder and run the installer:

| System | Installer |
| --- | --- |
| macOS | Double-click `Install.command` |
| Windows | Double-click `Install.cmd` |
| Linux | Open a terminal in the folder and run `bash install.sh` |

The installer registers the native host for your user account—no administrator privileges are required. If no prebuilt release is available yet, you can [build the packages locally](#development).

### 2. Load the browser extension

1. Move the extracted extension folder to a permanent location on your computer.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder containing **`manifest.json`**.

Keep this folder in place after loading it. The extension comes preconfigured to talk to the local native host—you don't need to enter an extension ID or copy your XIPU AI token.

### 3. Set up your XIPU AI session

1. Click **XIPU AI Bridge** in the browser toolbar. On the welcome screen, click **Start setup** to open the setup guide.
2. Click **Open XIPU AI** to open the [XIPU AI chat page](https://xipuai-xjtlu-edu-cn-s.xjtlu.edu.cn/chat), sign in, and refresh the tab. Then click **Load models** in the setup guide.
3. Pick an initial model and a unique conversation name, then click **Create bridge session**. The setup guide will create a dedicated conversation, set its Context Count to **0** with an empty system prompt, and save your local settings—without sending any test messages or spending credits.
4. Copy the **Base URL** and **API key** into your client.

Already set up on this computer? Click **Use existing setup** on the welcome screen to go straight to the dashboard. To bind an existing conversation instead of creating a new one, open **Settings → Load from XIPU AI → Use session**, then click **Save changes**.

Keep the `/chat` tab open and signed in while using your client (required for document uploads and multiple attachments). **You can switch models directly in your client—the bridge updates the dedicated conversation automatically.**

> [!NOTE]
> Prebuilt binaries are not Developer ID or Authenticode signed, or Apple notarized; your operating system may warn or block execution. See [installation options](docs/reference.md#installation-options) for Edge, Chromium, and Brave setup, or [troubleshooting](docs/reference.md#uninstall-and-troubleshooting) if the native host fails to connect.

On Linux, Chromium and Brave users should pass their browser explicitly: `bash install.sh --browser chromium` or `bash install.sh --browser brave`. See [Linux browser paths](docs/reference.md#linux-browser-paths) for custom config directories and NixOS notes.

## Connect your client

| Client setting | Value |
| --- | --- |
| API type | OpenAI-compatible |
| Base URL | `http://127.0.0.1:8765/v1` (default; copy the active URL from the popup) |
| API key | Copy the local key from the extension popup |
| Model | Any model ID returned by `/v1/models` (overrides the default model in Settings) |

Both `/v1/chat/completions` and `/v1/responses` are supported, and `/v1/models` returns the available model catalog. See the [API reference](docs/reference.md#api) for request examples and supported fields.

## Good to know

- **Usage and concurrency:** Requests use your own XIPU AI account and credit balance. The bridge processes one request at a time and never retries failed upstream requests automatically.
- **Session isolation:** When your client requests a different model, the bridge updates the dedicated conversation's model setting and leaves it selected afterward (even if a request fails or is cancelled). Avoid typing or editing settings in the dedicated conversation while a request is running. Conversations and uploaded files are stored on XIPU AI under its normal retention rules.
- **Token limits and usage reporting:** `max_tokens`, `max_completion_tokens`, and `max_output_tokens` are accepted for client compatibility, **but the bridge cannot enforce them as generation or spending limits.** Per-request token counts are unavailable. XIPU AI's **My Score** page reports account credits, which may update with a delay. See [client compatibility](docs/reference.md#client-compatibility).
- **Multimodal, tools, and history:** Image inputs require a vision-capable model, and PDF/text document uploads require the `/chat` interface (see [file formats and limits](docs/reference.md#files)). Function calling and JSON Schema outputs are emulated via prompts and validated locally rather than through native server-side constrained decoding. Both API endpoints are stateless, so your client must include prior messages on each turn.

## Documentation

| Guide | Contents |
| --- | --- |
| [Settings and sessions](docs/reference.md#settings) | Default parameters, model switching, reasoning options, timeouts, and API key rotation |
| [API reference](docs/reference.md#api) | Text, images, documents, streaming, function calling, structured output, and compatibility details |
| [Installation and troubleshooting](docs/reference.md#installation-options) | Additional browsers, upgrades, uninstalling, and common issues |
| [Security boundaries](docs/reference.md#security-boundaries) | Local authentication, credential isolation, and loopback restrictions |
| [Testing guide](docs/verification.md) | Automated test coverage and known verification boundaries |

## Development

With [Nix](https://nixos.org/download/) and [devenv](https://devenv.sh/getting-started/) installed:

```sh
devenv shell
bridge-check
bridge-release
```

Release archives are written to `dist/release/` and can be installed using the [steps above](#install). See the [development reference](docs/reference.md#development) for local builds, UI preview servers, and release workflows.

## License

Original code and documentation are dedicated to the public domain under [CC0 1.0 Universal](LICENSE). Third-party libraries and adapted styles keep their respective licenses; see [third-party notices](THIRD_PARTY_NOTICES.md) and [coss-ui attribution](docs/coss-ui-provenance.md).

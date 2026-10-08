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

A lightweight local bridge between your signed-in XIPU AI tab and the apps you use. A browser extension and a standalone Go executable work together to serve an authenticated API on your computer.

- **Text and images** through Chat Completions and the Responses API, with streaming support.
- **Function calls and structured output** through prompt-based compatibility and schema validation. Your client runs the tools.
- **Local control** over sessions, request defaults, timeouts, and API credentials. Your school token stays in the browser.
- **Standalone packages** for macOS, Windows, and Linux. No additional language runtime is needed.

> [!WARNING]
> **Disclaimer — account access and academic consequences**
>
> XIPU AI Bridge is an independent, unofficial project. It is not affiliated with, approved by, or endorsed by Xi'an Jiaotong-Liverpool University, XIPU AI, or any model provider. Availability of this software does not establish that its use is permitted by those parties.
>
> Users are responsible for obtaining any necessary authorization and complying with applicable laws, university regulations, academic integrity requirements, and service terms, including access and usage limits. **Unauthorized use, academic misconduct, or other violations may result in access restrictions, account suspension or permanent termination, and disciplinary action with serious consequences for academic standing or progression.** Any consequences depend on the applicable rules, circumstances, and decisions of the relevant institution or service provider.
>
> The software is provided **"AS IS," without warranties of any kind**, to the fullest extent permitted by law. To that extent, the authors and contributors disclaim liability for losses, service charges, account restrictions, disciplinary consequences, or other harm arising from its use. Nothing in this notice excludes liability that cannot lawfully be excluded.
>
> The CC0 dedication concerns rights in the project's original material. It grants no permission to access third-party services, circumvent controls, or disregard institutional requirements. This notice describes operational risks and does not add conditions to CC0.

## Install

### 1. Download and install the native app

From [Releases](https://github.com/Zerlight/XIPU-AI-openai-proxy/releases), download **both** the native package for your computer and **`xipu-bridge-extension.zip`**. Extract both archives. Choose `arm64` for Apple silicon or Windows/Linux ARM devices, or `amd64` for Intel/AMD 64-bit devices.

Open the extracted native package and run its installer:

| System | Installer |
| --- | --- |
| macOS | Double-click `Install.command` |
| Windows | Double-click `Install.cmd` |
| Linux | Open a terminal in the folder and run `bash install.sh` |

Installation is for your user account; no administrator access is needed. If no release is available yet, [build the packages locally](#development).

### 2. Load the browser extension

1. Move the extracted extension folder to a permanent location.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder containing **`manifest.json`**.

Keep this folder in place. The extension is already configured to connect to the native app; no extension ID or school token needs to be entered.

### 3. Connect XIPU AI

1. Sign in to XIPU AI and refresh the tab.
2. Create a dedicated conversation named **XIPU AI Bridge**. Choose your model, leave the system prompt empty, and set **Context Count** to **0**.
3. Open the extension's **Settings**, click **Load from XIPU AI**, select that conversation, then click **Use session** and **Save changes**.
4. Copy the **base URL** and **API key** from the extension popup into your client.

Keep the XIPU AI tab signed in. **The model requested by your client must match the selected conversation's model.**

> [!NOTE]
> Native packages are not code-signed or notarized; your operating system may block them. Browser integration requires platform-specific verification. See [installation options](docs/reference.md#installation-options) for Edge/Chromium and [troubleshooting](docs/reference.md#uninstall-and-troubleshooting) if setup fails.

## Connect your client

| Client setting | Value |
| --- | --- |
| API type | OpenAI-compatible |
| Base URL | `http://127.0.0.1:8765/v1` by default; copy the current URL from the popup |
| API key | Copy the local key from the popup |
| Model | The model selected in your dedicated XIPU AI conversation |

Both `/v1/chat/completions` and `/v1/responses` are available. The model list comes from `/v1/models`. See the [API reference](docs/reference.md#api) for examples and supported request fields.

## Know before you use it

The bridge uses your existing school access and usage allowance. It handles one request at a time and does not retry failed school requests automatically. Conversations and uploaded images remain on the school service.

**Client token limits do not cap generation or charges.** The bridge accepts `max_tokens`, `max_completion_tokens`, and `max_output_tokens` for compatibility but cannot enforce them. Per-request token usage is unavailable; school points are a separate account balance. See [client compatibility](docs/reference.md#client-compatibility).

Image input requires a vision-capable model. Function calls and JSON Schema output are prompted and validated by the bridge; they do not enable native tool calling or constrained decoding on the school server. The Responses API is stateless: clients must supply conversation history.

## Documentation

| Guide | Contents |
| --- | --- |
| [Settings and sessions](docs/reference.md#settings) | Defaults, model selection, reasoning, timeouts, and API keys |
| [API reference](docs/reference.md#api) | Text, images, streaming, function calls, structured output, and compatibility limits |
| [Installation and troubleshooting](docs/reference.md#installation-options) | Other browsers, upgrades, uninstalling, and common errors |
| [Security boundaries](docs/reference.md#security-boundaries) | Authentication, token handling, and local access |
| [Testing guide](docs/verification.md) | Automated coverage and verification limits |

## Development

With [Nix](https://nixos.org/download/) and [devenv](https://devenv.sh/getting-started/) installed:

```sh
devenv shell
bridge-check
bridge-release
```

Packages are written to `dist/release/`; use them with the [installation steps](#install) above. See the [development reference](docs/reference.md#development) for builds, UI previews, and release automation.

## License

Original material is dedicated to the public domain under [CC0 1.0 Universal](LICENSE). Third-party material retains its own terms; see [third-party notices](THIRD_PARTY_NOTICES.md) and [coss-ui attribution](docs/coss-ui-provenance.md).

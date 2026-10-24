# XIPU AI Bridge reference

[Back to the README](../README.md)

- [Installation options](#installation-options)
- [Settings](#settings)
- [Models and session isolation](#models-and-session-isolation)
- [API](#api)
- [Security boundaries](#security-boundaries)
- [Development](#development)
- [Publishing releases](#publishing-releases)
- [School chat frontends](#school-chat-frontends)
- [Platforms and release limits](#platforms-and-release-limits)
- [Uninstall and troubleshooting](#uninstall-and-troubleshooting)

## Installation options

For a standard Chrome setup, follow the [installation steps in the README](../README.md#install). The native host and browser extension are installed separately; the bundled extension has a fixed extension ID that the installer registers automatically.

Before upgrading the native host, quit your browser so the executable can be replaced cleanly. The installer copies the binary into your user configuration directory and preserves your existing settings and local API key, so you can delete the downloaded native archive afterward. Keep the unpacked extension folder in place. Your browser launches the native host on demand—do not start it manually as a background service.

To register the host for Microsoft Edge or Chromium, open a terminal in the extracted native package folder and run `./xipu-bridge install --browser edge` or `--browser chromium` (`.\xipu-bridge.exe` on Windows). The launcher scripts (`Install.command`, `Install.cmd`, and `install.sh`) also forward these flags. Pass `--dry-run` to preview the target paths without writing files or Windows registry keys, or `--extension-id YOUR_EXTENSION_ID` if you are loading a custom extension build.

### Linux browser paths

On Linux, the installer targets Chrome by default. Pass `--browser` to register for Chromium or Brave instead:

```sh
./xipu-bridge install --browser chromium
./xipu-bridge install --browser brave
```

- **Brave Stable** uses `$XDG_CONFIG_HOME/BraveSoftware/Brave-Browser/NativeMessagingHosts` (or `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts` when `XDG_CONFIG_HOME` is unset), ignoring Chrome-specific environment variables.
- **Chrome and Chromium** also check `CHROME_CONFIG_HOME` and `CHROME_USER_DATA_DIR` (with `CHROME_USER_DATA_DIR` taking precedence).
- The bridge's own configuration and API key always live under your OS user configuration directory (`XIPU AI Bridge`).

If you use a custom browser wrapper, non-stable release channel, or relocated profile directory on Linux or macOS, pass an explicit absolute path with `--native-host-dir`:

```sh
./xipu-bridge install --browser chromium --native-host-dir /absolute/browser-data/NativeMessagingHosts --dry-run
```

Verify the printed path, then re-run the command without `--dry-run`. Pass the same `--browser` and `--native-host-dir` flags when upgrading or uninstalling. To find your browser's user data directory in Chrome or Chromium, open `chrome://version` and check **Profile Path**—use its parent directory and append `NativeMessagingHosts` (do not place the manifest inside `Default` or `Profile 1`). See [Chromium's User Data Directory guide](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md) for details.

**NixOS and sandboxed browsers:** Install as the same user account that runs the browser. If Home Manager manages your Native Messaging manifests as symlinks, the installer will refuse to overwrite them; update your Nix configuration instead. Sandboxed Flatpak or Snap browsers may block host execution unless granted host access separately.

**Unsigned binaries and conflicting registrations:** Prebuilt binaries are not signed with an Apple Developer ID or Windows Authenticode certificate, or Apple notarized. macOS Gatekeeper or Windows SmartScreen may warn or block execution. In addition, the installer will refuse to overwrite a Native Messaging manifest that points to a different executable—uninstall the conflicting registration first.

## Settings

Once setup is complete, clicking the extension icon shows your connection status, active Base URL, and local API key. Opening **Settings** gives you full control over local defaults, connection parameters, timeouts, and appearance:

| Setting | Default | Description |
| --- | --- | --- |
| Local port | `8765` | Local TCP port for the API server. Restart the bridge after saving to bind the new port. |
| Session name | `XIPU AI Bridge` | Exact, unique name of the dedicated XIPU AI conversation. |
| Default model | Empty | Fallback model used when an API request omits `model`. |
| Thinking effort | `minimal` | Default reasoning effort when a request omits `thinking` or `reasoning_effort`. |
| Online search | Off | Default web-search toggle when a request omits `online`. |
| Include reasoning | On | Include `reasoning_content` in Chat Completions responses. |
| Text-only image history | Off | Strip images from earlier answered turns while keeping text descriptions; current-turn images are still sent. |
| Chat timeout | `300` seconds | Overall time limit for a completion request (`10`–`1800` seconds). |
| Model list timeout | `30` seconds | Time limit for `GET /v1/models` (`5`–`120` seconds). |
| Idle timeout | `90` seconds | Max wait between upstream stream events (`5`–`600` seconds, up to the chat timeout). |
| Capture requests locally | Off | Save the latest request body, upstream payload, and diagnostic events to `debug/latest.json`. |
| Use webpage send flow | Off | Send requests through the legacy `/v3/chat` UI so responses appear live in the open page. |
| Theme | `System` | `System`, `Light`, or `Dark`, shared across the popup, setup guide, and settings page. |

Both the UI and the native host validate settings before saving. Clicking **Save changes** writes to a temporary file before replacing `config.json`. Most settings take effect immediately while the bridge is idle; changing the local port requires clicking **Restart bridge** (or **Reconnect**), and the displayed Base URL updates once the new port is bound. **Reset defaults** populates the form with default values without saving until you click **Save changes**, and **Reload saved** reverts unsaved edits.

From the **Connection** tab, you can also reveal or copy your local API key, or click **Replace API key** to generate a new one (which immediately invalidates the old key). Settings changes and key rotation are disabled while a request is in flight.

Note that turning off **Include reasoning** only hides `reasoning_content` from API responses—it does not stop the model from thinking on the server or reduce credit usage.

Theme preferences are stored in browser extension storage, while host settings and the local API key are saved in your OS user configuration directory under `XIPU AI Bridge`. Upgrades preserve the key and existing settings; `--session-name` and `--port` override only their respective settings.

### Debugging

Under **Advanced → Debugging**, two optional diagnostic modes are available (both off by default):

- **Capture requests locally (`debug_capture_requests`):** Writes the most recent API request body (including prompts and base64 attachments), the translated XIPU AI payload, and bounded diagnostic events to `debug/latest.json` inside the host configuration directory. `Authorization` headers are stripped, and each new request overwrites the previous file. Because the file contains your prompt and attachment data, treat it as sensitive and delete it manually when you finish debugging.
- **Use webpage send flow (`debug_web_session`):** Drives the legacy `/v3/chat` page's built-in Vue composer so prompts and replies are saved in school history and responses render live in the browser tab. To use this mode:
  1. Open `/v3/chat`, select the dedicated conversation, and make sure it already has at least one prior message (sending a first message in an empty conversation causes the webpage to auto-rename the session).
  2. Manually select the target model on the page and set Context Count to **0** (this mode does not switch models automatically).
  3. Keep the message box empty, clear any pending file attachments, and close any open dialogs before sending an API request.

  While a request is running, the page UI is temporarily locked (`inert`); you can still cancel the request from your API client. If the page state does not match these requirements, the request fails immediately without falling back to direct API calls.

## Models and session isolation

### First-run setup

When you open the extension for the first time, the welcome screen prompts you to **Start setup** (you can also reopen the setup guide anytime from the popup or Settings). Clicking **Open XIPU AI** launches the `/chat` interface, which supports PDF/text documents and up to 10 attachments per request.

When you click **Create bridge session**, the setup guide:
1. Creates a new XIPU AI conversation with your chosen name (never overwriting an existing conversation of the same name).
2. Pauses briefly (3 seconds) between session writes to reduce rate-limit errors; the school may still reject a request.
3. Configures the conversation with your selected initial model, **Context Count 0**, and an empty system prompt, then verifies the saved state.
4. Saves the session name and default model to your local host configuration—without sending any chat completion or consuming model credits.

If setup is interrupted (for example, by closing the tab or a network timeout), progress is saved locally so you don't end up with duplicate sessions:
- **Resume setup** continues configuring a conversation whose session ID was already confirmed, or retries saving local host settings.
- **Check setup** performs a read-only lookup on XIPU AI to see whether an interrupted creation succeeded and recovers its session ID if found.
- **Stop waiting** cancels an in-progress setup wait.
- **Use existing setup** (on the welcome screen) or saving a session in **Settings** skips onboarding and goes straight to the dashboard.

### Existing conversations

In **Settings → General**, clicking **Load from XIPU AI** fetches your conversation list and model catalog in read-only mode (only session names, models, and context counts are read—never chat transcripts or tokens). Conversations with duplicate names or a non-zero Context Count are marked unavailable. Selecting a valid conversation and clicking **Use session** fills in the form fields; click **Save changes** to apply them.

When your client sends an API request:
- Any `model` specified in the API request overrides the default model in Settings.
- The bridge checks the dedicated conversation on XIPU AI and verifies that its Context Count is **0**.
- In the default direct send mode, if the conversation is set to a different model, the bridge updates the conversation's model (preserving its other settings) and verifies the change before sending the prompt.
- That model selection remains saved on the conversation afterward, even if the completion fails or is cancelled. Keep the dedicated conversation reserved exclusively for the bridge.

The bridge requests isolation by verifying **Context Count 0** and formats the conversation history supplied by your client on every turn. This setting does not prove how the upstream service handles history or remove server-side instructions. Concurrent changes from the school interface or another client can also affect the shared conversation.

## API

| Endpoint | Description |
| --- | --- |
| `GET /health` | Unauthenticated local health check (`ok`, `transport`, connected `tabs`, and `busy` state) |
| `GET /v1/models` | Authenticated list of models available to your signed-in XIPU AI account |
| `POST /v1/chat/completions` | OpenAI Chat Completions (text, images, files, tool calls, structured output, JSON or SSE) |
| `POST /v1/responses` | Stateless OpenAI Responses API (text, images, files, tool calls, structured output, JSON or typed SSE) |

Authenticate all `/v1/*` requests with `Authorization: Bearer <LOCAL_API_KEY>`, using the local key shown in the extension popup.

```sh
curl http://127.0.0.1:8765/v1/chat/completions \
  -H "Authorization: Bearer $XIPU_LOCAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.6-27b","messages":[{"role":"user","content":"Reply OK"}],"reasoning_effort":"minimal","stream":false}'
```

A single user message is sent as plain text. Multi-turn conversations are formatted into a labeled transcript (`[system]`, `[developer]`, `[user]`, `[assistant]`, and tool call/result blocks). Supported thinking levels are `minimal`, `low`, `medium`, and `high` (unrecognized values fall back to `minimal`). `online` accepts a boolean or `0`/`1`. Per-request parameters override your defaults in Settings.

### Images

Pass images using `image_url` parts in Chat Completions or `input_image` parts in Responses, as either a base64 `data:` URL or a public `https://` URL:
- Remote image URLs are fetched by the local host without your XIPU AI credentials. Private/loopback IPs, link-local addresses, URLs with embedded credentials, and unsafe redirects are blocked.
- Supported formats are **PNG, JPEG, static GIF, and WebP**, up to **10 MiB per image**, **16,384 px per side**, **40 megapixels**, and **16 MiB total decoded attachments** per request (within an overall **24 MiB** HTTP body limit). Animated GIFs and `detail` levels other than `auto` are rejected.
- Before uploading, the bridge verifies that the requested model advertises `multimodal` support.

**Historical images and text-only models:** If earlier turns in a conversation contain images, they still count as image inputs even when the latest message is text-only. Sending a conversation with images to a text-only model returns HTTP **400** (`unsupported_image_model`) before any upload or session change. To continue a conversation using a text-only model, switch to a vision model or enable **Settings → General → Text-only image history** (`omit_historical_images`). When enabled, images from earlier turns that have already been answered by the assistant are replaced with a placeholder marker while keeping text descriptions intact; images in the current turn (or an active tool-call turn) are still uploaded normally.

### Files

Document uploads require a signed-in `/chat` tab with **Use webpage send flow** turned off. Attempting to send files through `/v3/chat` or webpage send mode returns HTTP **400** (`unsupported_file_frontend`).

Supported document formats on both `/v1/responses` and `/v1/chat/completions` are **PDF, UTF-8 TXT, Markdown (`.md`/`.markdown`), and CSV**:
- In **Responses**, use `input_file` with `filename` and either `file_data` (raw base64 or a matching `data:` URL) or `file_url` (a public `https://` URL):
  ```json
  {
    "model": "YOUR_MODEL_ID",
    "store": false,
    "input": [{
      "role": "user",
      "content": [
        {"type": "input_text", "text": "Summarize the attached report."},
        {"type": "input_file", "filename": "report.pdf", "file_data": "data:application/pdf;base64,..."}
      ]
    }]
  }
  ```
- In **Chat Completions**, use `{"type":"file","file":{"filename":"report.pdf","file_data":"..."}}` inside a message's content array, following the [OpenAI file-input format](https://developers.openai.com/api/docs/guides/file-inputs).
- Filenames must be safe ASCII basenames (`1`–`128` characters) ending in a supported extension. Local filesystem paths and OpenAI `file_id` references are not supported.

On `/chat`, images and documents share a limit of **10 retained attachments** per request (whereas legacy `/v3/chat` supports at most **1 image** and no documents), with **10 MiB per file** and **16 MiB combined decoded bytes**. Note that **Text-only image history** only omits earlier images—historical documents remain in subsequent turns unless removed by your client.

Document-only requests do not require a vision-capable model. In the tested scanned PDF, printed text and numbers were recognized but visual details available from the same page as a PNG were not. Document parsing may expose extracted text without page images; use image input when diagrams or colors matter. Uploaded images and files remain in XIPU AI storage under its retention rules.

### Attachment upload errors

If an image or file upload to XIPU AI fails, the API stops immediately and returns HTTP **502** with `error.code: "attachment_upload_failed"`, `error.param` pointing to the exact content part in your request, and an `attachment` metadata object:

```json
{
  "error": {
    "message": "Attachment 2/3 (report.pdf): The school upload failed.",
    "type": "bridge_error",
    "code": "attachment_upload_failed",
    "param": "input[0].content[2]",
    "attachment": {
      "index": 1,
      "total": 3,
      "filename": "report.pdf",
      "kind": "file"
    }
  }
}
```

- `param` preserves the original request index (such as `messages[i].content[j]`, `input[i].content[j]`, or `input[i].output[j]`), even when earlier historical images were omitted.
- `attachment.index` is zero-based among retained attachments, while the human-readable message uses 1-based numbering (`Attachment 2/3`).
- Because uploads happen before generation starts, `stream: true` requests also receive this standard JSON error response.

### Error details

API errors include `error.type`, `error.code`, `error.message`, and (for field-level validation or upload failures) `error.param`. In addition, the bridge includes `error.stage` and `error.upstream` (`http_status` and `school_code`) when available:

```json
{
  "error": {
    "message": "Generate response: The school service is temporarily unavailable (HTTP 503). Try again later; no automatic retry was made.",
    "type": "bridge_error",
    "code": "school_http_error",
    "stage": "generation",
    "upstream": { "http_status": 503 }
  }
}
```

| Condition | HTTP status | `error.code` |
| --- | --- | --- |
| Invalid or unsupported request parameter | `400` | `invalid_request`, `unsupported_parameter` |
| Missing or invalid local API key | `401` | `invalid_api_key` |
| Dedicated session missing, duplicated, or has non-zero Context Count | `400` | `school_session_not_found`, `school_session_ambiguous`, `school_session_unsafe` |
| Requested model not in the XIPU AI catalog | `400` | `school_model_unavailable` |
| Signed out of XIPU AI or upstream HTTP 401 | `502` | `school_auth_required` |
| Upstream HTTP 429 rate limit | `429` | `school_rate_limited` |
| Other upstream HTTP error | `502` | `school_http_error` |
| Upstream non-zero business code or generation error | `502` | `school_rejected` |
| Malformed upstream JSON or unexpected payload shape | `502` | `school_invalid_response` |
| Browser fetch failure to XIPU AI | `502` | `school_network_error` |
| Session model update failed readback verification | `502` | `school_session_update_failed` |
| Truncated SSE frame or mid-stream failure | `502` (or SSE error event) | `school_stream_incomplete`, `school_stream_error` |
| Empty model output or failed tool/schema validation | `502` | `missing_result`, `invalid_generation` |
| Native host disconnected or invalid chunk framing | `502` | `native_disconnected`, `native_request_invalid` |
| Native chunk assembly timed out | `504` | `native_request_timeout` |
| Overall completion timeout or stream idle timeout | `504` | `bridge_timeout`, `bridge_idle_timeout` |
| No connected XIPU AI tab, tab closed, or another request is running | `503` | `tab_unavailable`, `school_tab_disconnected`, `bridge_busy` |

If an error occurs before streaming begins, the server returns an HTTP error status with a JSON body. Once `200 OK` SSE headers have been sent, mid-stream failures are emitted as an `error` SSE event (Chat Completions) or a `response.failed` event (Responses) containing the same error details.

### Function calls and structured output

Both Chat Completions and Responses support `tools` (`type: "function"`) and `tool_choice`, as well as `json_object` and `json_schema` output formats (`response_format` in Chat Completions, `text.format` in Responses):
- **How it works:** Because XIPU AI does not expose native function-calling or constrained-decoding parameters, the bridge injects an output protocol into the prompt and validates the model's entire JSON response locally before returning it to your client. Your client executes the functions and sends the tool results back on the next turn.
- **Validation limits:** JSON Schema validation uses `santhosh-tekuri/jsonschema` (Draft 2020-12) with external network/file `$ref` loading disabled. JSON payloads are bounded to 64 nesting levels and 1,024-character numbers (exponents `-1000` to `1000`), and schemas are bounded to 64 KiB and 4,096 nodes. If the model's output fails validation, the request returns HTTP **502** (`invalid_generation`) without retrying.
- **Streaming behavior:** Plain text deltas are forwarded as they arrive from the upstream service. When tools or structured JSON outputs are requested, the bridge buffers the upstream stream until the full JSON payload has been validated, then emits the result as JSON or synthetic SSE events (so time-to-first-token will be higher).

### Responses compatibility

`POST /v1/responses` supports string or array `input`, `instructions`, images, files, function tools, `function_call` / `function_call_output` items, `reasoning.effort`, and typed SSE streaming events.

Because the bridge is stateless:
- Pass `store: false` (or omit `store`) and include full conversation history in `input` on each turn.
- Unsupported request fields such as `store: true`, `previous_response_id`, `background: true`, `include`, and automatic `truncation` return HTTP **400** (`unsupported_parameter`). Hosted tools and encrypted reasoning state are not supported; validation codes depend on the rejected field. There is no WebSocket endpoint.
- `temperature` is also rejected on both endpoints because temperature is controlled by the XIPU AI conversation settings.
- Raw thinking text is exposed as `reasoning_content` in Chat Completions; the Responses API does not include reasoning summaries.

```sh
curl http://127.0.0.1:8765/v1/responses \
  -H "Authorization: Bearer $XIPU_LOCAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.6-27b","input":"Reply OK","store":false,"stream":true}'
```

### Client compatibility

Configure your client to use **OpenAI Chat Completions** or **OpenAI Responses**. The Anthropic Messages API (`/v1/messages`) is not implemented and returns HTTP 404, even when calling Claude models hosted on XIPU AI.

- **Token limit parameters (`max_tokens`, `max_completion_tokens`, `max_output_tokens`):** Accepted (as positive integers or `null`) so clients that always send them can connect without errors, and reported in the `X-XIPU-Ignored-Parameters` response header. **They do not cap output length, reasoning tokens, or credit usage.** The bridge does not forward these fields to XIPU AI.
- **Usage reporting (`stream_options.include_usage`):** Accepted on Chat Completions. When set to `true`, responses include the `X-XIPU-Usage: unavailable` header and set `usage: null` on chunks (without fabricating zero-token counts). Responses API objects always return `usage: null`. The **My Score** page in XIPU AI reports account credits; its updates may be delayed and are not per-request token counts.

## Security boundaries

- **Loopback-only API:** The native host listens exclusively on `127.0.0.1`, verifies the `Host` header, and requires `Authorization: Bearer <LOCAL_API_KEY>` for all `/v1/*` routes.
- **Origin and context checks:** Only the registered browser extension ID can launch the native host or call settings RPCs, and only top-level `https://xipuai.xjtlu.edu.cn` or `https://xipuai-xjtlu-edu-cn-s.xjtlu.edu.cn` `/chat` and `/v3/chat` tabs can connect as content scripts.
- **Credential isolation:** Your XIPU AI login token is used only for school requests inside the signed-in browser tab; it is never sent to the native host or exposed to local API clients. The extension contains no telemetry.

## Development

With [Nix](https://nixos.org/download/) and [devenv](https://devenv.sh/getting-started/) installed:

```sh
devenv shell
bridge-check
bridge-build
bridge-release
```

- `bridge-check` (or `devenv test`) runs `gofmt`, `go vet`, Go unit tests (with `-race` on macOS and Linux), Node.js syntax and unit tests, and full end-to-end integration tests across the Go binary and extension scripts.
- `bridge-release` builds static (`CGO_ENABLED=0`), stripped binaries and release archives for macOS, Linux, and Windows (`arm64` and `amd64`), packages `xipu-bridge-extension.zip`, and writes `SHA256SUMS` to `dist/release/`. Run `bash packaging/check.sh` to smoke-test the generated archives and installers.
- `bridge-icons` regenerates the PNG extension icons from `design/logo/xipu-ai-bridge.svg` using `resvg`.
- To preview and test the extension UI in a regular browser with mock data, run `node tests/popup-preview.cjs` or `node tests/options-preview.cjs`. Append `?onboarded=1` to view the popup dashboard, or `?phase=creating|created|configured|complete` to preview setup recovery states.

See [third-party notices](../THIRD_PARTY_NOTICES.md), [coss-ui adaptation notes](coss-ui-provenance.md), and the [testing guide](verification.md) for additional details.

## Publishing releases

Pushing a version tag (`v<version>`, matching `extension/manifest.json`, such as `v0.4.1`) triggers the GitHub Actions workflow to run the test suite on macOS, Linux, and Windows, verify the packaged archives, and publish the six native archives, `xipu-bridge-extension.zip`, and `SHA256SUMS` to GitHub Releases. Tags ending in `-rc.N` (such as `v0.4.1-rc.1`) are published as prereleases without replacing the latest stable release.

## School chat frontends

We recommend using the current [XIPU AI `/chat` page](https://xipuai-xjtlu-edu-cn-s.xjtlu.edu.cn/chat) for both initial setup and daily use. The extension automatically detects whether the active tab is on `/chat` or legacy `/v3/chat` and uses the matching upstream API format:
- **`/chat` (recommended):** Supports text, up to 10 attachments per request (shared across images and PDF/TXT/Markdown/CSV documents), and all current models. Requires **Use webpage send flow** to be turned **off**.
- **`/v3/chat` (legacy):** Supports text, at most 1 image per request (no document uploads), and the optional **Use webpage send flow** debugging mode.

If multiple XIPU AI chat tabs are open, requests are routed to the most recently connected tab. Other pages on the XIPU AI domain (such as login or account pages) do not connect to the bridge. Note that specialized web-only features on `/chat` (such as standalone document-parsing options or async media generation) are not mapped to the local OpenAI endpoints.

## Platforms and release limits

- **Supported browsers:** Chrome, Edge, and Chromium on macOS, Windows, and Linux (`arm64` and `amd64`), plus Brave Stable on Linux. Firefox, mobile browsers, and ChromeOS are not supported.
- **Single active profile:** Only one browser instance can bind the configured local API port at a time; starting a second instance on the same port will report a port-in-use error.

## Uninstall and troubleshooting

To remove the Native Messaging registration for a browser, run:

```sh
./xipu-bridge uninstall --browser chrome
```

(Use `.\xipu-bridge.exe` on Windows, or `./dist/xipu-bridge` if built from source.) Uninstalling removes that browser's manifest and registry entry while leaving your `XIPU AI Bridge` configuration directory and API key intact. You can then remove the extension from `chrome://extensions` and delete the `XIPU AI Bridge` folder from your OS user configuration directory if you no longer need it.

| Symptom | What to check |
| --- | --- |
| Native host not found | Re-run the installer for your browser and verify that the printed manifest path matches your browser's configuration directory. |
| Host exits immediately | Check whether another process is already using port `8765`, whether `config.json` is valid, or whether your OS blocked the unsigned binary. |
| "Sign in needed" / no connected tab | Make sure XIPU AI `/chat` (or `/v3/chat`) is open and signed in, then refresh the tab—especially right after installing or reloading the extension. |
| Model switch or session check fails | Verify that a single conversation has your configured session name and that its Context Count is set to `0`. |
| Saved port differs from active Base URL | Click **Restart bridge** (or **Reconnect**) while idle so the host binds the new port. |
| HTTP 401 after replacing API key | Copy the newly generated API key from the extension into your client. |
| Settings save or session load fails | Check the error banner, click **Reconnect** if the host went offline, and try again. |

When reporting an issue, please redact your local API key, XIPU AI token, and personal chat transcripts.

If the native host fails to launch on Linux, quit the browser completely, start it from a terminal with Native Messaging logging enabled, and click **Reconnect** in the extension:

```sh
chromium --enable-logging=stderr --log-level=1 2>&1 | grep -E 'native_messag|launch_context|xipu-bridge'
```

(Replace `chromium` with your browser's command, and make sure no existing browser process is already running in the background.) Include the extension popup error and matching log lines in your bug report. See [Chrome's Native Messaging debugging guide](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#debug-native-messaging) for more tips.

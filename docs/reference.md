# XIPU AI Bridge reference

[Back to the README](../README.md)

- [Installation options](#installation-options)
- [Settings](#settings)
- [Models and session isolation](#models-and-session-isolation)
- [API](#api)
- [Security boundaries](#security-boundaries)
- [Development](#development)
- [Publishing releases](#publishing-releases)
- [Platforms and release limits](#platforms-and-release-limits)
- [Uninstall and troubleshooting](#uninstall-and-troubleshooting)

## Installation options

For the standard Chrome setup, follow [Install in the README](../README.md#install). Native registration and the browser extension are separate installations. The bundled extension has a fixed ID; the installer uses it automatically.

Close browsers before upgrading the native app. The installer copies the executable to its permanent location and preserves settings and the local API key, so the extracted native package can be removed afterward. Keep the extracted extension folder in place. Chrome starts the native host automatically; do not run it as a separate background service.

For Edge or Chromium, open a terminal in the extracted native package and run `./xipu-bridge install --browser edge` or `--browser chromium` (`.\xipu-bridge.exe` on Windows). Launchers also forward these arguments. `--dry-run` describes installation without writing files or registry entries. Custom extension builds may pass `--extension-id YOUR_EXTENSION_ID`.

### Linux browser paths

Select the browser when installing; the default is Chrome:

```sh
./xipu-bridge install --browser chromium
./xipu-bridge install --browser brave
```

Run only the command for the browser you use. Linux Brave stable uses `$XDG_CONFIG_HOME/BraveSoftware/Brave-Browser/NativeMessagingHosts`, or `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts` when XDG_CONFIG_HOME is unset. Chrome and Chromium also honor `CHROME_CONFIG_HOME` and `CHROME_USER_DATA_DIR`; the latter takes precedence. Brave uses its default XDG directory for native hosts independently of those Chrome variables. The bridge's own settings remain under the OS user configuration directory.

For a custom browser wrapper, release channel, or relocated Chromium data directory, Linux and macOS support an explicit absolute manifest directory:

```sh
./xipu-bridge install --browser chromium --native-host-dir /absolute/browser-data/NativeMessagingHosts --dry-run
```

Check the printed path, then repeat without `--dry-run`. Use the same browser and directory arguments when upgrading or uninstalling. This option overrides browser environment variables and only changes registration placement. For Chrome/Chromium, `chrome://version` shows the Profile Path: use its parent directory, then append `NativeMessagingHosts`; do not place the manifest inside `Default` or `Profile 1`. Match the browser's actual environment when launching the installer. [Chromium documents these directory rules](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md).

On NixOS, use the packaged browser launcher and install as the same user who runs the browser. Home Manager may own host manifests as symlinks; the installer refuses to overwrite managed symlinks. Update the owning declaration instead. Sandboxed browser distributions can require separate native-host integration; changing the manifest directory alone does not grant access through a sandbox. The bridge communicates through Native Messaging stdin/stdout and a loopback TCP API, so it has no desktop socket path to configure.

Native packages currently lack Developer ID signing, Apple notarization, and Windows Authenticode signing, so operating-system security checks may prevent a downloaded executable from running. A signed Git commit is separate from executable signing. Smooth macOS distribution requires the [Developer ID and notarization workflow](https://developer.apple.com/developer-id/); the installation launchers do not change OS security settings.

The installer refuses to overwrite a registration belonging to a different executable. Remove a conflicting registration through its own installation procedure before installing this host.

## Settings

After onboarding, the popup shows connection status and client credentials. The full settings page opens in its own tab, grouped into General, Connection, and Advanced. Keyboard navigation and validation keep the relevant section accessible without discarding unsaved edits. It offers:

| Setting | Default | Behavior |
| --- | --- | --- |
| API port | 8765 | After saving, reconnect the host to bind the new port |
| Dedicated session | XIPU AI Bridge | Exact, unique school conversation name |
| Default model | Empty | Used only when an API request omits `model` |
| Thinking effort | minimal | Default for requests without `thinking` or `reasoning_effort` |
| Online search | Off | Default for requests without `online` |
| Include reasoning | On | Include `reasoning_content` in client responses |
| Text-only image history | Off | Omit images from earlier answered turns; keep existing descriptions and send current images normally |
| Chat timeout | 300 seconds | Total time allowed for a completion; 10–1800 seconds |
| Catalog timeout | 30 seconds | Time allowed for the API model list; 5–120 seconds |
| Idle timeout | 90 seconds | Maximum gap between school events; 5–600 seconds and no longer than the chat timeout |
| Capture requests locally | Off | Keep the latest request and derived school payload in a local debug file |
| Use webpage send flow | Off | Send through the official webpage and display the response live in the dedicated conversation |
| Appearance | System | System, light, or dark, shared by popup and settings |

Settings are validated by both the UI and native host. **Save** writes a temporary file before replacing the saved configuration. Most changes apply immediately while idle; changing the port requires an explicit reconnect. The displayed base URL remains the actual bound address until that reconnect succeeds. Restore defaults edits the form and requires Save to take effect. Reload reads the host's current saved configuration.

The settings page also provides masked key reveal/copy, explicit API-key rotation, connection details, and read-only school discovery. Rotation invalidates the old local key; update each client afterward. Mutations and reconnects are refused while another operation is active. Failed or timed-out writes are not automatically retried; reload settings to verify the saved state.

Turning off Include reasoning only omits reasoning from client responses. It does not disable the school's thinking process or reduce its usage charges. School discovery has a separate fixed 30-second limit; the catalog timeout controls `GET /v1/models`.

Appearance is stored in extension storage. Host settings and the local key live under the OS user configuration directory in `XIPU AI Bridge`. Reinstalling preserves saved settings and the local key; explicit installer `--session-name` or `--port` flags override those two fields.

### Debugging

**Advanced → Debugging** offers two independent options, both off by default. Save changes to apply them; Reset defaults switches them off in the form.

**Capture requests locally** (`debug_capture_requests`) stores the complete API request body, including prompts and attachment data, the derived school payload, and diagnostic events in `debug/latest.json` under the host configuration directory. This private local file is outside the repository and replaces the previous capture. Authentication headers are excluded. Diagnostic event capture is bounded and marks truncation explicitly. Treat the file as sensitive; turning capture off stops new captures but does not remove the saved file.

**Use webpage send flow** (`debug_web_session`) uses the legacy `/v3/chat` page's official Send flow so the dedicated conversation shows the response live. Before sending an API request:

- Open the dedicated conversation and load its existing messages. Empty conversations are refused because the webpage's first send would rename them.
- Select the requested model and set Context Count to 0. Both the saved session and the visible page must match; this mode does not switch models automatically.
- Leave the composer empty, remove pending webpage attachments, close the upload dialog, and wait for any active webpage operation to finish.

Page controls are temporarily locked during the request; cancellation remains available through the API client. If the supported send interface or its state cannot be verified, the request fails without falling back to the direct send path or retrying. The school controls server history retention; this option does not guarantee persistent or unlimited history.

## Models and session isolation

### First-run setup

The first time you open the extension from the toolbar, it shows a welcome screen. Choose **Start setup** to open the guide in a new tab; you can reopen it through **Setup** in the dashboard or Settings. **Open XIPU AI** opens the recommended `/chat` frontend, which supports documents and multiple attachments. The guide checks the native connection and signed-in tab, loads available models, and lets you create a dedicated conversation with a unique name. Creation is an explicit action; opening the extension does not create a conversation or generate a response.

For a previously configured connection, **Use existing setup** skips the guide and opens the dashboard. This choice does not verify or change the school conversation. Existing conversations can be selected through Settings.

Setup first creates the conversation using its name, then configures its chosen model, Context Count 0, and empty system prompt. It verifies the saved identity and settings before saving the local session name and default model. Other native settings remain unchanged. Existing conversations with the same name are never overwritten.

Before configuration, setup waits three seconds to space the school session writes. This pause also applies when explicitly resuming configuration, is shown in the guide, and can be cancelled with **Stop waiting**. A rejected request is not retried automatically. The school may still rate-limit requests; the pause does not establish its quota or guarantee acceptance.

Interrupted setup retains minimal progress in trusted extension storage. The welcome screen offers **Continue setup** or **Review setup** to reopen the guide. If the new conversation ID is known, **Resume setup** continues configuration without creating another conversation. If only the local save failed, resuming repeats that local save.

After a school error or timeout, **Refresh** reads local connection status without contacting the school. **Check setup** makes an explicit, read-only check for the conversation and recovers its identity and configuration when possible. **Stop waiting** cancels the pending setup operation; a school change may already have completed. Setup never automatically retries an uncertain creation, including after HTTP 502. If the conversation is not visible yet, check again later or select an existing dedicated conversation in Settings. Successfully saving Settings exits onboarding; the bridge validates that conversation on the next API request. The school API has no confirmed idempotency mechanism, so concurrent creation from another browser or client cannot be excluded.

### Existing conversations

Reading the school's catalog and sessions does not generate a response or change school settings. Discovery returns only model/session display metadata, never the school token or chat history. Select a session and click **Use session** to fill its name and default model in the local form, then **Save changes** to apply them. This does not change the school conversation. Unsafe or ambiguous sessions cannot be selected.

An explicit API `model` always takes precedence over the configured default. Before generation, the bridge reads the selected school conversation and requires its Context Count to be 0. In the default send mode, if the model differs, it updates that conversation's model while preserving its other settings, then verifies the saved model, unchanged session ID, and Context Count 0 before sending a completion. A failed update or verification stops the request. The optional [webpage send mode](#debugging) requires the requested model to be selected already.

Model changes persist. Failure or cancellation after an update can leave the new model selected; the bridge does not roll back changes or retry automatically. Reserve the selected conversation exclusively for the bridge, and do not manually edit it or send messages there while a request is active.

Only the explicit Setup action creates a school conversation. Ordinary API requests never create, clear, or delete conversations. The school may retain responses in the dedicated conversation; outside webpage send mode, the page may need a refresh to show them. Server retention and unlimited history are not guaranteed. With Context Count 0, each request supplies the client's complete transcript as text. School-side prompt and generation settings still apply.

## API

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Minimal unauthenticated process/tab status |
| `GET /v1/models` | Authenticated school model catalog |
| `POST /v1/chat/completions` | Text, images, files, function calls, and structured output; streaming or JSON |
| `POST /v1/responses` | Stateless Responses-compatible input/output and typed SSE events |

Use `Authorization: Bearer <LOCAL_API_KEY>` for API calls. This key is independent of the school token.

```sh
curl http://127.0.0.1:8765/v1/chat/completions \
  -H "Authorization: Bearer $XIPU_LOCAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.6-27b","messages":[{"role":"user","content":"Reply OK"}],"reasoning_effort":"minimal","stream":false}'
```

One user message becomes plain text. Multiple messages become a transcript with role labels such as `[system]`, `[user]`, and `[assistant]`. Tool calls, their IDs, and their associated results are preserved in that transcript. These labels do not create native role channels in the school API. Thinking levels are `minimal`, `low`, `medium`, and `high`; unsupported explicit effort values map to `minimal`. `online` accepts a boolean or 0/1. Explicit request values override generation defaults.

### Images

Use Chat Completions `image_url` content parts or Responses `input_image` parts. Supply a base64 data URL or a public HTTPS image URL. Remote images are downloaded without school credentials; private, loopback, link-local, credential-bearing, and unsafe redirect destinations are rejected. The host validates the image, transfers it in bounded Native Messaging chunks, and the signed-in page uploads it through the school's official multipart endpoint. The resulting attachment URLs accompany the completion. Before uploading, the bridge checks that the requested model advertises `multimodal` support and verifies the dedicated session's saved model, switching it automatically when needed.

Images in conversation history count as image input, even when the latest message is text-only. A model that does not advertise image support returns HTTP **400** with `error.type: invalid_request_error` and `error.code: unsupported_image_model`, before any school session change, upload, or generation. Use an image-capable model, start a text-only conversation, or explicitly enable **Settings → General → Text-only image history**.

That setting (`omit_historical_images`, off by default) applies to every model. It replaces earlier image attachments with an explicit image-unavailable marker while retaining existing text and assistant descriptions. An image is eligible only when an assistant reply follows it and a later user turn follows that reply. Current images, consecutive unanswered user inputs, and images in an ongoing tool exchange stay intact. Omitted attachments are not downloaded, decoded, or uploaded, and no captions are generated. The model can use the retained text but cannot inspect omitted visual details. Turn the setting off to preserve all images again.

The bridge accepts PNG, JPEG, static GIF, and WebP. Attachment counts follow the school chat frontend: `/chat` accepts up to **10 retained attachments** in total, including images and documents, while legacy `/v3/chat` accepts **one image**. Exceeding the selected frontend's limit returns HTTP 400 before any school request; attachments are never silently dropped.

Size limits are 10 MiB per image, 16 MiB of decoded attachment bytes per request, 16,384 pixels per side, and 40 megapixels per image. HTTP requests and serialized native jobs are limited to 24 MiB, including base64 overhead and text; the HTTP limit includes any omitted image data supplied by the client. These are bridge safety limits, not a guarantee of school capacity. Images remain ordered and are referenced in the text transcript. Omit `detail` or use `auto`; resolution selection and OpenAI-hosted file IDs are not supported.

Uploaded images are sent to school storage and are not automatically deleted, including after cancellation or failure. Uploads are never automatically retried.

### Files

To send files, keep a `/chat` tab signed in and turn off **Use webpage send flow**. On `/v3/chat` or in webpage send mode, document requests return HTTP **400** with `error.code: unsupported_file_frontend` before any school request.

Responses accepts `input_file` parts with `filename` and `file_data`. Supply raw base64 or a base64 data URL whose MIME type matches the filename extension:

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

For Chat Completions, use `{"type":"file","file":{"filename":"report.pdf","file_data":"..."}}` inside message content. These shapes follow the [OpenAI file-input formats](https://developers.openai.com/api/docs/guides/file-inputs). The bridge accepts PDF, UTF-8 TXT, Markdown, and CSV on both endpoints; text formats in Chat Completions are a bridge extension to OpenAI's documented PDF support.

Responses also accepts `file_url` instead of `file_data` for public HTTPS files. Downloads use the same private-network, credential, redirect, and size protections as remote images. Supply a filename when the URL path does not end in a supported extension. Filenames must be safe ASCII basenames of at most 128 characters. Local file paths, hosted `file_id` references, and a persistent Files API are unsupported.

Images and documents share a limit of **10 retained attachments** on `/chat`, matching its ordinary chat upload limit, with **10 MiB per attachment** and **16 MiB of decoded data in total**. The 24 MiB HTTP/native-job limit also applies, including base64 overhead. Files are validated before upload and uploaded sequentially in transcript order. If an upload fails, generation does not start and the upload is not retried; successfully uploaded files are not automatically deleted. Documents retained in conversation history count toward these limits; Text-only image history applies only to images.

Document input does not require the chat model's image capability flag. Requests that include image parts still do. The school service controls document parsing and model selection and may attribute a response to `Document-Parsing` even when a chat model was requested. PDF upload support does not guarantee OCR, recognition of embedded figures, or successful parsing of every PDF. Uploads go to school storage and remain subject to its retention and usage rules.

### Attachment upload errors

Both endpoints return HTTP **502** with `error.code: attachment_upload_failed` when a school upload fails. `error.param` identifies the failed content part in the original request, so clients can locate it without parsing the message:

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

Paths use `messages[i].content[j]` for Chat Completions, `input[i].content[j]` for Responses messages, or `input[i].output[j]` for Responses function outputs. They retain their original indices after internal message conversion or omission of earlier images. Duplicate filenames are distinguished by the path.

`attachment` is a bridge extension: `index` is the zero-based upload position among retained images and documents, `total` is their combined count, `filename` is the upload basename (generated for images), and `kind` is `image` or `file`. The human-readable message uses a one-based position and the verified upload basename. These fields contain no file data or source URLs. When an older extension cannot identify the failed attachment, the API returns a generic upstream error without attachment metadata.

Upload failures occur before response streaming starts, so `stream:true` requests also receive this JSON error. Clients must read these fields to highlight the failed attachment; the metadata alone does not change their interfaces. After the first failure, no further attachments are uploaded and generation does not start. Uploads are not automatically retried.

### Error details

Use `error.code` for classification and `error.param`, when present, to locate an invalid request field. `error.message` is a human-readable explanation. Local validation identifies specific fields, including individual attachment content parts, where possible. For malformed input, it may identify only the enclosing field.

`error.stage` and `error.upstream` are bridge extensions. The stage identifies where the failure occurred: local validation, connection handling, authentication, model discovery, session operations, attachment upload, generation, or stream processing. Upstream metadata includes the observed `http_status` and numeric `school_code` when available:

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

| Failure | API status | Error code |
| --- | --- | --- |
| Invalid or unsupported request field | 400 | `invalid_request`, `unsupported_parameter` |
| Invalid local API key | 401 | `invalid_api_key` |
| Missing, ambiguous, or unsafe dedicated session | 400 | `school_session_not_found`, `school_session_ambiguous`, `school_session_unsafe` |
| Model absent from the school catalog | 400 | `school_model_unavailable` |
| Missing school sign-in or upstream HTTP 401 | 502 | `school_auth_required` |
| Upstream HTTP 429 outside an attachment upload | 429 | `school_rate_limited` |
| Other unsuccessful school HTTP response | 502 | `school_http_error` |
| School business-code rejection | 502 | `school_rejected` |
| Invalid school JSON or response structure | 502 | `school_invalid_response` |
| School fetch failure | 502 | `school_network_error` |
| Session update fails verification | 502 | `school_session_update_failed` |
| Incomplete SSE frame or stream failure | 502 before streaming | `school_stream_incomplete`, `school_stream_error` |
| Empty result or invalid structured output | 502 | `missing_result`, `invalid_generation` |
| Native connection lost or invalid transport chunks | 502 | `native_disconnected`, `native_request_invalid` |
| Native request assembly timeout | 504 | `native_request_timeout` |
| Overall or idle timeout | 504 | `bridge_timeout`, `bridge_idle_timeout` |
| No school tab, disconnected tab, or another active request | 503 | `tab_unavailable`, `school_tab_disconnected`, `bridge_busy` |

Attachment upload failures retain `attachment_upload_failed` and their attachment location, with upstream metadata for the underlying failure. HTTP 403 is reported as a school HTTP error, not assumed to be an expired login. Numeric business codes do not establish content filtering, exhausted credits, or another undocumented cause. Unknown errors remain `upstream_error`; unavailable metadata is omitted.

Failures before streaming return a JSON error. Once SSE has started, the HTTP status is already committed: Chat Completions emits an `error` event and Responses emits `response.failed`, carrying the same available diagnostic fields. Clients must inspect these events instead of treating HTTP 200 alone as success. These fields do not enable automatic retries, and client interfaces must support them to display more specific guidance.

### Function calls and structured output

Function tools use the standard Chat Completions or Responses request shapes. The bridge prompts the model with the supplied definitions, then validates the complete generated envelope, tool names, argument schemas, and tool-choice constraints before returning calls. **This is prompt-based compatibility, not school-native function calling.** The client executes the tools and sends their results back with matching call IDs. The proxy does not execute commands, invoke MCP servers, or provide hosted tools.

Chat Completions `response_format` and Responses `text.format` accept JSON object and JSON Schema output formats. Validation uses the pinned `santhosh-tekuri/jsonschema` library. External schema resources are disabled; schemas cannot read local files or fetch remote URLs. Only a valid result is returned as successful. Invalid output fails without another model request. Schema validation, including `strict` requests, validates the result after generation; it does not enable constrained decoding on the school server.

Validation limits JSON nesting to 64 levels, numeric literals to 1,024 characters and exponents from -1,000 to 1,000, and each schema to 64 KiB and 4,096 JSON values. Local references and embedded schema resources are supported.

Ordinary text streams immediately. Tool and structured-output responses are buffered until validation succeeds, then returned as JSON or compatible SSE events. They therefore have higher time to first output. Include the complete prior tool-call/result history in subsequent requests.

### Responses compatibility

`POST /v1/responses` accepts text or message `input`, `instructions`, images, files, function definitions, and function call/result items. Use `store:false`; the client supplies conversation history. Responses SSE uses typed events with stable item IDs and sequence numbers, including completion and failure events.

Response storage, `previous_response_id`, background jobs, response retrieval/deletion, WebSockets, hosted tools, and provider-specific encrypted reasoning state are unsupported. Raw school reasoning is available as Chat Completions `reasoning_content`; Responses do not include a reasoning summary. Request-specific temperature is rejected because the school conversation owns that setting. Unsupported request fields return an error. The response `model` identifies the requested route, not independently verified model provenance.

```sh
curl http://127.0.0.1:8765/v1/responses \
  -H "Authorization: Bearer $XIPU_LOCAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.6-27b","input":"Reply OK","store":false,"stream":true}'
```

Only one school operation runs at a time. Busy requests fail without starting school work. Client disconnects and timeouts cancel active requests. Errors after SSE headers become structured error events without a successful stop. Like the school frontends, the bridge accepts either `[DONE]` or clean EOF after complete SSE events. Incomplete event frames, stream read failures, and explicit school errors still fail. A server that silently closes after a complete event cannot be distinguished from a normal end of the response. School requests are never automatically retried, including after HTTP 429. An already accepted generation may still be billed after cancellation.

### Client compatibility

Configure clients to use **OpenAI Chat Completions** or **Responses**. The Anthropic Messages API (`/v1/messages`) is not implemented and returns 404, even when the selected model is from Anthropic.

Chat Completions accepts `max_tokens` and `max_completion_tokens`; Responses accepts `max_output_tokens`. Values must be positive integers or `null`. If both Chat fields are supplied with non-null values, they must agree. **These are accepted for client compatibility only: they do not limit generation length, reasoning, school points, or charges.** They are not forwarded to the school or added to the prompt. Responses to otherwise valid requests disclose supplied non-null limits in the `X-XIPU-Ignored-Parameters` header.

Chat Completions accepts `stream_options: {"include_usage": true}` without rejecting the request. Every completion chunk then contains `usage: null`, and the response header is `X-XIPU-Usage: unavailable`. There is no final usage-only chunk with numeric totals. This supports clients that tolerate unknown usage; it does not provide full OpenAI usage accounting. Without this option, Chat Completions omits usage. Responses objects always have `usage: null`. The bridge does not estimate token totals or report them as zero. Clients may display unavailable usage as zero; those placeholders do not establish measured usage or the absence of charges.

The school's **My Score** page reports account allowances and points used. Model prices express points per token quantity, but neither provides a reliable per-request breakdown of input, output, or reasoning tokens. These points cannot substitute for API token usage. Clients that require numeric usage or a guaranteed output budget are not fully supported.

## Security boundaries

The host binds only to loopback and requires API authentication. It validates extension origins, settings-page callers, job routing, and Context Count 0. These checks apply to every configuration. Allowed extension origins are managed by the installer.

School requests run only in the signed-in page, using its normal authentication and proxy hooks. The school token stays there. The extension serves its UI assets locally and does not collect telemetry. Native host stdout carries framed protocol messages; errors go to stderr.

## Development

Install [Nix](https://nixos.org/download/) and [devenv](https://devenv.sh/getting-started/), then run:

```sh
devenv shell
bridge-check
bridge-build
bridge-release
```

`devenv.lock` pins the toolchain inputs. Checks include formatting, vet, Go tests, the race detector on macOS/Linux, JavaScript syntax and behavior tests, and a real Go subprocess connected through all three extension worlds with synthetic school responses. `devenv test` runs the same checks.

Release builds use `CGO_ENABLED=0`, stripped debug information, and trimmed paths. The release script produces macOS, Linux, and Windows binaries and installation archives for ARM64 and x86-64, an allowlisted extension ZIP, and SHA256SUMS under `dist/release/`. Run `bash packaging/check.sh` inside the development shell to check the generated packages and installer launchers.

The logo source is `design/logo/xipu-ai-bridge.svg`. Run `bridge-icons` to regenerate the extension assets with resvg; release builds also regenerate them automatically.

Pinned Go libraries provide JSON Schema validation and WebP decoding; their licenses ship with release artifacts. See [third-party notices](../THIRD_PARTY_NOTICES.md). The extension styles include adaptations of coss-ui components; see [design provenance](coss-ui-provenance.md). Test coverage and verification limits are documented in [the testing guide](verification.md).

For a synthetic UI preview, run `node tests/popup-preview.cjs` or `node tests/options-preview.cjs` with the development Node runtime. The popup starts at its welcome screen; add `onboarded=1` to preview the dashboard. Setup recovery states are available with `phase=creating|created|configured|complete`. These fixtures do not connect to the school or installed extension.

## Publishing releases

The GitHub workflow tests macOS, Linux, and Windows and checks the release packages. Pushing a `v<version>` tag publishes the six native installation archives, the extension ZIP, and a checksum file to GitHub Releases only after those jobs succeed. Stable tags must match `extension/manifest.json` (for example, `v0.4.1`). Tags ending in `-rc.N`, where N is a positive integer, publish a prerelease without replacing the latest stable release (for example, `v0.4.1-rc.1`). Ordinary branch pushes only produce CI artifacts. The release checksum file covers the downloadable assets, while the local build checksum file also covers raw binaries and license files.

Release creation uses the workflow's repository token, with write access limited to the publishing job. Native executables are not signed by this workflow.

## School chat frontends

Use the newer [school chat page](https://xipuai-xjtlu-edu-cn-s.xjtlu.edu.cn/chat) for setup and normal use. The browser bridge selects the school protocol from the tab's route. Both `/v3/chat` and `/chat` use the same dedicated-session checks: a unique name, a confirmed ID, and Context Count 0. The current `/chat` frontend uses its own sign-in store, model catalog, attachment payload, and generation endpoint. Images keep the same bridge size and model-capability checks. Legacy `/v3/chat` remains compatible with text and one image per request. No request is automatically replayed through the other frontend after an error.

Keep one school chat tab open when choosing a frontend; the most recently connected chat tab receives requests. Other pages on the school domain cannot establish a bridge connection. **Use webpage send flow** currently requires `/v3/chat`; turn it off for `/chat`.

The `/chat` adapter is covered by synthetic protocol and native-host integration tests. Live checks have also verified model discovery, streamed text, single-image input through Responses, two ordered images through Chat Completions, and a two-request isolation check. These checks do not establish compatibility with every model or session configuration; an advertised model can still fail during generation. School errors are returned without automatic retries.

The newer webpage's ordinary chat uploader allows multiple files of any type, with default UI limits of ten files and 30 MiB per file. Its document-parsing mode has separate format and option settings. The bridge sends its supported [file inputs](#files) through ordinary chat with attachment URLs in upload order. Selecting a file does not guarantee successful parsing or establish a server-side limit. The webpage's broader upload controls do not change the bridge's attachment limits.

The school interface also exposes dedicated document-parsing options and asynchronous media creation. These controls are not currently mapped to the local API. Search annotations and media task results need separate response handling; their presence does not establish native support for OpenAI function calls, JSON Schema enforcement, token limits, or per-request token usage.

## Platforms and release limits

User-level registration supports Chrome, Edge, and Chromium on macOS, Linux, and Windows, plus Brave stable on Linux. Cross-compilation is not runtime validation; Windows/Linux browsers and macOS x86-64 still require hardware acceptance testing. Snap and Flatpak browser packages may need separate host integration. Firefox, mobile browsers, and ChromeOS are outside this version's scope.

Use one active browser/profile for the host. Concurrent hosts compete for the configured port; the second host reports a bind error. Keep the selected school tab signed in. The installation archives contain unsigned native binaries; packaging does not establish operating-system trust.

## Uninstall and troubleshooting

```sh
./xipu-bridge uninstall --browser chrome
```

Run this from the extracted native package; use `.\xipu-bridge.exe` on Windows, or `./dist/xipu-bridge` for a local build. Uninstall removes the selected browser registration and preserves the shared binary, configuration, and key. Remove the extension through the browser UI. Delete the `XIPU AI Bridge` configuration directory only after no browser uses it.

| Symptom | Check |
| --- | --- |
| Native host not found | Register for this browser and the extension's current ID; compare the printed manifest path with the browser's configuration directory |
| Host exits immediately | Check for a port conflict, invalid config, or an OS execution restriction |
| No connected tab | Refresh the signed-in school tab after reloading the extension |
| Model switch or session validation fails | Check the requested model, unique conversation name, and Context Count 0; inspect the saved school model after a failed update |
| Saved port differs from base URL | Reconnect while idle to bind the saved port |
| API 401 after rotation | Copy the new local key into the client |
| Settings save or discovery fails | Read the error, reconnect if necessary, then explicitly reload or retry |

Keep credentials and personal transcripts out of issue reports.

For Linux native-host launch failures, fully quit the browser, start its usual packaged launcher with logging, then reconnect the extension:

```sh
chromium --enable-logging=stderr --log-level=1 2>&1 | grep -E 'native_messag|launch_context|xipu-bridge'
```

Replace `chromium` with the installed browser's launcher. An already running browser can receive the new invocation without adopting its logging flags. Record the extension popup error and the relevant native-host log lines. Browser zygote startup errors alone do not identify a Native Messaging failure. See [Chrome's Native Messaging troubleshooting](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#debug-native-messaging).

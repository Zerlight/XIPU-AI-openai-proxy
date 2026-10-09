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
| Appearance | System | System, light, or dark, shared by popup and settings |

Settings are validated by both the UI and native host. **Save** writes a temporary file before replacing the saved configuration. Most changes apply immediately while idle; changing the port requires an explicit reconnect. The displayed base URL remains the actual bound address until that reconnect succeeds. Restore defaults edits the form and requires Save to take effect. Reload reads the host's current saved configuration.

The settings page also provides masked key reveal/copy, explicit API-key rotation, connection details, and read-only school discovery. Rotation invalidates the old local key; update each client afterward. Mutations and reconnects are refused while another operation is active. Failed or timed-out writes are not automatically retried; reload settings to verify the saved state.

Turning off Include reasoning only omits reasoning from client responses. It does not disable the school's thinking process or reduce its usage charges. School discovery has a separate fixed 30-second limit; the catalog timeout controls `GET /v1/models`.

Appearance is stored in extension storage. Host settings and the local key live under the OS user configuration directory in `XIPU AI Bridge`. Reinstalling preserves saved settings and the local key; explicit installer `--session-name` or `--port` flags override those two fields.

## Models and session isolation

### First-run setup

The first toolbar opening shows a welcome screen. Choose **Start setup** to open the guide in a new tab; it can also be reopened through **Setup** in the dashboard or Settings. It checks the native connection and signed-in tab, loads available models, and lets you create a dedicated conversation with a unique name. Creation is an explicit action; opening the extension does not create a conversation or generate a response.

For a previously configured connection, **Use existing setup** skips the guide and opens the dashboard. This choice does not verify or change the school conversation. Existing conversations can be selected through Settings.

Setup first creates the conversation using its name, then configures its chosen model, Context Count 0, and empty system prompt. It verifies the saved identity and settings before saving the local session name and default model. Other native settings remain unchanged. Existing conversations with the same name are never overwritten.

Before configuration, setup waits three seconds to space the school session writes. This pause also applies when explicitly resuming configuration, is shown in the guide, and can be cancelled with **Stop waiting**. A rejected request is not retried automatically. The school may still rate-limit requests; the pause does not establish its quota or guarantee acceptance.

Interrupted setup retains minimal progress in trusted extension storage. The welcome screen offers **Continue setup** or **Review setup** to reopen the guide. If the new conversation ID is known, **Resume setup** continues configuration without creating another conversation. If only the local save failed, resuming repeats that local save.

After a school error or timeout, **Refresh** reads local connection status without contacting the school. **Check setup** makes an explicit, read-only check for the conversation and recovers its identity and configuration when possible. **Stop waiting** cancels the pending setup operation; a school change may already have completed. Setup never automatically retries an uncertain creation, including after HTTP 502. If the conversation is not visible yet, check again later or select an existing dedicated conversation in Settings. Successfully saving Settings exits onboarding; the bridge validates that conversation on the next API request. The school API has no confirmed idempotency mechanism, so concurrent creation from another browser or client cannot be excluded.

### Existing conversations

Reading the school's catalog and sessions does not generate a response or change school settings. Discovery returns only model/session display metadata, never the school token or chat history. Select a session and click **Use session** to fill its name and default model in the local form, then **Save changes** to apply them. This does not change the school conversation. Unsafe or ambiguous sessions cannot be selected.

An explicit API `model` always takes precedence over the configured default. Before generation, the bridge reads the selected school conversation and requires its Context Count to be 0. If the model differs, it updates that conversation's model while preserving its other settings, then verifies the saved model, unchanged session ID, and Context Count 0 before sending a completion. A failed update or verification stops the request.

Model changes persist. Failure or cancellation after an update can leave the new model selected; the bridge does not roll back changes or retry automatically. Reserve the selected conversation exclusively for the bridge, and do not manually edit it or send messages there while a request is active.

Only the explicit Setup action creates a school conversation. Ordinary API requests never create, clear, or delete conversations. Responses remain visible in the dedicated conversation. With Context Count 0, each request supplies the client's complete transcript as text. School-side prompt and generation settings still apply.

## API

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Minimal unauthenticated process/tab status |
| `GET /v1/models` | Authenticated school model catalog |
| `POST /v1/chat/completions` | Text, images, function calls, and structured output; streaming or JSON |
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

The bridge accepts PNG, JPEG, static GIF, and WebP: at most four retained images, 10 MiB per image, 16 MiB of decoded image bytes per request, 16,384 pixels per side, and 40 megapixels per image. HTTP requests and serialized native jobs are limited to 24 MiB, including base64 overhead and text; the HTTP limit still includes omitted image data supplied by the client. The school's own limits may be lower. Images remain ordered and are referenced in the text transcript. Omit `detail` or use `auto`; resolution selection and OpenAI-hosted file IDs are not supported.

Uploaded images are sent to school storage and are not automatically deleted, including after cancellation or failure. Uploads are never automatically retried.

### Function calls and structured output

Function tools use the standard Chat Completions or Responses request shapes. The bridge prompts the model with the supplied definitions, then validates the complete generated envelope, tool names, argument schemas, and tool-choice constraints before returning calls. **This is prompt-based compatibility, not school-native function calling.** The client executes the tools and sends their results back with matching call IDs. The proxy does not execute commands, invoke MCP servers, or provide hosted tools.

Chat Completions `response_format` and Responses `text.format` accept JSON object and JSON Schema output formats. Validation uses the pinned `santhosh-tekuri/jsonschema` library. External schema resources are disabled; schemas cannot read local files or fetch remote URLs. Only a valid result is returned as successful. Invalid output fails without another model request. Schema validation, including `strict` requests, validates the result after generation; it does not enable constrained decoding on the school server.

Validation limits JSON nesting to 64 levels, numeric literals to 1,024 characters and exponents from -1,000 to 1,000, and each schema to 64 KiB and 4,096 JSON values. Local references and embedded schema resources are supported.

Ordinary text streams immediately. Tool and structured-output responses are buffered until validation succeeds, then returned as JSON or compatible SSE events. They therefore have higher time to first output. Include the complete prior tool-call/result history in subsequent requests.

### Responses compatibility

`POST /v1/responses` accepts text or message `input`, `instructions`, images, function definitions, and function call/result items. Use `store:false`; the client supplies conversation history. Responses SSE uses typed events with stable item IDs and sequence numbers, including completion and failure events.

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

The GitHub workflow tests macOS, Linux, and Windows and checks the release packages. Pushing a `v<version>` tag publishes the six native installation archives, the extension ZIP, and a checksum file to GitHub Releases only after those jobs succeed. The tag must exactly match `extension/manifest.json` (for example, `v0.1.0`); ordinary branch pushes only produce CI artifacts. The release checksum file covers the downloadable assets, while the local build checksum file also covers raw binaries and license files.

Release creation uses the workflow's repository token, with write access limited to the publishing job. Native executables are not signed by this workflow.

## Platforms and release limits

User-level registration supports Chrome, Edge, and Chromium on macOS, Linux, and Windows. Cross-compilation is not runtime validation; Windows/Linux browsers and macOS x86-64 still require hardware acceptance testing. Snap and Flatpak browser packages may need separate host integration. Firefox, mobile browsers, and ChromeOS are outside this version's scope.

Use one active browser/profile for the host. Concurrent hosts compete for the configured port; the second host reports a bind error. Keep the selected school tab signed in. The installation archives contain unsigned native binaries; packaging does not establish operating-system trust.

## Uninstall and troubleshooting

```sh
./xipu-bridge uninstall --browser chrome
```

Run this from the extracted native package; use `.\xipu-bridge.exe` on Windows, or `./dist/xipu-bridge` for a local build. Uninstall removes the selected browser registration and preserves the shared binary, configuration, and key. Remove the extension through the browser UI. Delete the `XIPU AI Bridge` configuration directory only after no browser uses it.

| Symptom | Check |
| --- | --- |
| Native host not found | Register for this browser and the extension's current ID |
| Host exits immediately | Check for a port conflict, invalid config, or an OS execution restriction |
| No connected tab | Refresh the signed-in school tab after reloading the extension |
| Model switch or session validation fails | Check the requested model, unique conversation name, and Context Count 0; inspect the saved school model after a failed update |
| Saved port differs from base URL | Reconnect while idle to bind the saved port |
| API 401 after rotation | Copy the new local key into the client |
| Settings save or discovery fails | Read the error, reconnect if necessary, then explicitly reload or retry |

Keep credentials and personal transcripts out of issue reports.

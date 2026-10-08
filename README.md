# XIPU AI Bridge

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

A Go Native Messaging host and Chromium extension. It exposes an authenticated OpenAI-compatible API on `127.0.0.1` and forwards requests through your signed-in XIPU AI tab, including image uploads.

The native executable runs without an additional runtime.

## Install

1. Choose the native binary for your operating system and CPU architecture from `dist/release/`. Alternatively, build `dist/xipu-bridge` with `devenv shell -- bridge-build`.
2. Extract `dist/release/xipu-bridge-extension.zip` into a permanent folder. In Chrome, Edge, or Chromium's extension management page, enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`. When working from source, you can load the repository's `extension/` folder instead. Keep the folder in place. The included public key fixes the extension ID as `eegmaembfjajhifjbddmdbppchinmmcg`.
3. Register the native host. For the macOS ARM64 release binary, run this from the repository directory:

   ```sh
   ./dist/release/xipu-bridge_darwin_arm64 install --browser chrome
   ```

   Replace the executable path with your platform's binary, or `./dist/xipu-bridge` for a local build. The installer uses the official extension ID by default; custom builds with a different ID can pass `--extension-id YOUR_EXTENSION_ID`. Choose `--browser edge` or `--browser chromium` as appropriate. `--dry-run` describes the installation without writing files or registry entries. Installation is per user.
4. Sign in to XIPU AI in a browser tab. Refresh any school tab that was already open when you loaded the extension so its content scripts can connect. Create a dedicated conversation named **XIPU AI Bridge**, leave its system prompt empty, choose a model, and set **Context Count** to **0**.
5. Open the extension popup, then **Settings**. Read the school's models and sessions, choose the dedicated session, and save. Copy the base URL and local API key into your client.

The extension and native executable are separate installations under [Chrome's Native Messaging contract](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). The manifest includes the Chrome Web Store public key so unpacked and store installations share the same ID. This public key is not a signing credential. See [Chrome's extension identity guidance](https://developer.chrome.com/docs/extensions/reference/manifest/key).

The current release is an unsigned development package for unpacked loading. For normal Chrome installation on Windows and macOS without Developer mode, distribute the extension through the Chrome Web Store; self-hosted installation requires enterprise management. See [Chrome's distribution rules](https://developer.chrome.com/docs/extensions/how-to/distribute). A store item can be **Unlisted**, allowing installation through its store URL, but it still undergoes the same policy review as a public listing. See [store visibility and review requirements](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution).

The installer refuses to overwrite a registration belonging to a different executable. Remove a conflicting registration through its own installation procedure before installing this host.

## Settings

The popup shows connection status and client credentials. The full settings page opens in its own tab, grouped into General, Connection, and Advanced. Keyboard navigation and validation keep the relevant section accessible without discarding unsaved edits. It offers:

| Setting | Default | Behavior |
| --- | --- | --- |
| API port | 8765 | Saved immediately; reconnect the host to bind the new port |
| Dedicated session | XIPU AI Bridge | Exact, unique school conversation name |
| Default model | Empty | Used only when an API request omits `model` |
| Thinking effort | minimal | Default for requests without `thinking` or `reasoning_effort` |
| Online search | Off | Default for requests without `online` |
| Include reasoning | On | Include `reasoning_content` in client responses |
| Chat timeout | 300 seconds | Total time allowed for a completion; 10–1800 seconds |
| Catalog timeout | 30 seconds | Time allowed for the API model list; 5–120 seconds |
| Idle timeout | 90 seconds | Maximum gap between school events; 5–600 seconds and no longer than the chat timeout |
| Appearance | System | System, light, or dark, shared by popup and settings |

Settings are validated by both the UI and native host. **Save** writes a temporary file before replacing the saved configuration. Most changes apply immediately while idle; changing the port requires an explicit reconnect. The displayed base URL remains the actual bound address until that reconnect succeeds. Restore defaults edits the form and requires Save to take effect. Reload reads the host's current saved configuration.

The settings page also provides masked key reveal/copy, explicit API-key rotation, connection details, and read-only school discovery. Rotation invalidates the old local key; update each client afterward. Mutations and reconnects are refused while another operation is active. Failed or timed-out writes are not automatically retried; reload settings to verify the saved state.

Turning off Include reasoning only omits reasoning from client responses. It does not disable the school's thinking process or reduce its usage charges. School discovery has a separate fixed 30-second limit; the catalog timeout controls `GET /v1/models`.

Appearance is stored in extension storage. Host settings and the local key live under the OS user configuration directory in `XIPU AI Bridge`. Reinstalling preserves saved settings and the local key; explicit installer `--session-name` or `--port` flags override those two fields.

## Models and session isolation

Reading the school's catalog and sessions does not generate a response or change school settings. Discovery returns only model/session display metadata, never the school token or chat history. Choosing a session fills its name and default model in the local form; it does not change the school conversation. Unsafe or ambiguous sessions cannot be selected.

An explicit API `model` always takes precedence over the configured default. Before generation, the bridge reads the selected school conversation and requires its model to match the resolved API model and its Context Count to be 0. A mismatch fails before any completion is sent. To use another model, select a matching school conversation in Settings, or change that conversation's model in the official interface.

The bridge never creates, modifies, clears, or deletes school conversations. Responses remain visible in the dedicated conversation. With Context Count 0, each request supplies the client's complete transcript as text. School-side prompt and generation settings still apply.

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

Use Chat Completions `image_url` content parts or Responses `input_image` parts. Supply a base64 data URL or a public HTTPS image URL. Remote images are downloaded without school credentials; private, loopback, link-local, credential-bearing, and unsafe redirect destinations are rejected. The host validates the image, transfers it in bounded Native Messaging chunks, and the signed-in page uploads it through the school's official multipart endpoint. The resulting attachment URLs accompany the completion. The model must advertise `multimodal` support, and the dedicated session must match it before any upload starts.

The bridge accepts PNG, JPEG, static GIF, and WebP: at most four images, 10 MiB per image, 16 MiB of decoded image bytes per request, 16,384 pixels per side, and 40 megapixels per image. HTTP requests and serialized native jobs are limited to 24 MiB, including base64 overhead and text. The school's own limits may be lower. Images remain ordered and are referenced in the text transcript. Omit `detail` or use `auto`; resolution selection and OpenAI-hosted file IDs are not supported.

Uploaded images are sent to school storage and are not automatically deleted, including after cancellation or failure. Uploads are never automatically retried.

### Function calls and structured output

Function tools use the standard Chat Completions or Responses request shapes. The bridge prompts the model with the supplied definitions, then validates the complete generated envelope, tool names, argument schemas, and tool-choice constraints before returning calls. **This is prompt-based compatibility, not school-native function calling.** The client executes the tools and sends their results back with matching call IDs. The proxy does not execute commands, invoke MCP servers, or provide hosted tools.

Chat Completions `response_format` and Responses `text.format` accept JSON object and JSON Schema output formats. Validation uses the pinned `santhosh-tekuri/jsonschema` library. External schema resources are disabled; schemas cannot read local files or fetch remote URLs. Only a valid result is returned as successful. Invalid output fails without another model request. Schema validation, including `strict` requests, validates the result after generation; it does not enable constrained decoding on the school server.

Validation limits JSON nesting to 64 levels, numeric literals to 1,024 characters and exponents from -1,000 to 1,000, and each schema to 64 KiB and 4,096 JSON values. Local references and embedded schema resources are supported.

Ordinary text streams immediately. Tool and structured-output responses are buffered until validation succeeds, then returned as JSON or compatible SSE events. They therefore have higher time to first output. Include the complete prior tool-call/result history in subsequent requests.

### Responses compatibility

`POST /v1/responses` accepts text or message `input`, `instructions`, images, function definitions, and function call/result items. Use `store:false`; the client supplies conversation history. Responses SSE uses typed events with stable item IDs and sequence numbers, including completion and failure events.

Response storage, `previous_response_id`, background jobs, response retrieval/deletion, WebSockets, hosted tools, and provider-specific encrypted reasoning state are unsupported. Raw school reasoning is available as Chat Completions `reasoning_content`; Responses do not include a reasoning summary. Request-specific temperature is rejected because the school conversation owns that setting. Unsupported request fields, including token limits, return an error. Token usage statistics are unavailable. The response `model` identifies the requested route, not independently verified model provenance.

```sh
curl http://127.0.0.1:8765/v1/responses \
  -H "Authorization: Bearer $XIPU_LOCAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.6-27b","input":"Reply OK","store":false,"stream":true}'
```

Only one school operation runs at a time. Busy requests fail without starting school work. Client disconnects and timeouts cancel active requests. Errors after SSE headers become structured error events without a successful stop. Missing school completion markers are treated as truncated responses. School requests are never automatically retried, including after HTTP 429. An already accepted generation may still be billed after cancellation.

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

Release builds use `CGO_ENABLED=0`, stripped debug information, and trimmed paths. The release script produces macOS, Linux, and Windows binaries for ARM64 and x86-64, an allowlisted extension ZIP, and SHA256SUMS under `dist/release/`.

The logo source is `design/logo/xipu-ai-bridge.svg`. Run `bridge-icons` to regenerate the extension assets with resvg; release builds also regenerate them automatically.

Pinned Go libraries provide JSON Schema validation and WebP decoding; their licenses ship with release artifacts. See [third-party notices](THIRD_PARTY_NOTICES.md). The extension styles include adaptations of coss-ui components; see [design provenance](docs/coss-ui-provenance.md). Test coverage and platform validation are documented in [the verification record](docs/verification.md).

For a synthetic UI preview, run `node tests/popup-preview.cjs` or `node tests/options-preview.cjs` with the development Node runtime. These fixtures do not connect to the school or installed extension.

## Platforms and release limits

User-level registration supports Chrome, Edge, and Chromium on macOS, Linux, and Windows. Cross-compilation is not runtime validation; Windows/Linux browsers and macOS x86-64 still require hardware acceptance testing. Snap and Flatpak browser packages may need separate host integration. Firefox, mobile browsers, and ChromeOS are outside this version's scope.

Use one active browser/profile for the host. Concurrent hosts compete for the configured port; the second host reports a bind error. Keep the selected school tab signed in. These binaries are unsigned release candidates, not store-published or notarized installers.

## Uninstall and troubleshooting

```sh
./dist/release/xipu-bridge_darwin_arm64 uninstall --browser chrome
```

Use the same platform binary as for installation, or `./dist/xipu-bridge` for a local build. Uninstall removes the selected browser registration and preserves the shared binary, configuration, and key. Remove the extension through the browser UI. Delete the `XIPU AI Bridge` configuration directory only after no browser uses it.

| Symptom | Check |
| --- | --- |
| Native host not found | Register for this browser and the extension's current ID |
| Host exits immediately | Check for a port conflict, invalid config, or an OS execution restriction |
| No connected tab | Refresh the signed-in school tab after reloading the extension |
| Model/session mismatch | Match the chosen conversation's model and set Context Count 0 |
| Saved port differs from base URL | Reconnect while idle to bind the saved port |
| API 401 after rotation | Copy the new local key into the client |
| Settings save or discovery fails | Read the error, reconnect if necessary, then explicitly reload or retry |

Keep credentials and personal transcripts out of issue reports.

## License

The project's original material is dedicated to the public domain under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). See [LICENSE](LICENSE) for the full legal text.

Third-party material is excluded from this dedication and retains its original terms. See [third-party notices](THIRD_PARTY_NOTICES.md) for Go dependencies. Adapted coss-ui styles retain their [MIT license and copyright notice](extension/styles/LICENSE.coss.txt); their sources and adaptations are documented in [coss-ui provenance](docs/coss-ui-provenance.md).

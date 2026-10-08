# Verification record

Date: October 8, 2026. Host: macOS ARM64. All API fixtures and UI preview data are synthetic; no school credentials, account identifiers, or live model responses are stored here.

## Checks

- Go formatting, vet, and race tests passed with Nix-provided Go 1.26.7.
- The actual Go executable completed a loopback HTTP / Native Messaging round trip through the background, isolated content script, and page script. Both JSON and SSE completions passed, as did catalog conversion, authentication, model mismatch rejection, truncated-stream errors, and clean shutdown. Settings reads/writes, persisted request defaults, reasoning omission, read-only school inspection, protected-field rejection, and local API-key rotation passed through the same path.
- Component tests covered cancellation, timeouts, job routing, reconnect without request replay, split UTF-8/CRLF SSE, exact event-size bounds, origin checks, and school-token containment.
- Image tests covered actual PNG/JPEG/GIF/WebP decoding, MIME mismatches, animation/dimension/byte limits, public HTTPS downloads, DNS pinning, mixed public/private addresses, unsafe redirects, cancellation, and redacted errors. Native transport tests covered ordered 256 KiB chunks, transfer limits, fragmentation, and non-interleaving. Extension tests covered assembly errors/timeouts, model/session guards, ordered uploads, failure without retry, and cleanup of local buffers.
- The real-process integration test sent a deterministic valid PNG larger than 1 MiB through every bridge layer, verified the exact multipart file bytes, and checked the resulting school attachment URL in the completion. It also exercised upload HTTP 429 with no retry or generation afterward, Responses images/text/typed SSE, two-round function calls through both API formats, and valid/invalid JSON Schema output.
- Protocol tests covered tool choice, unknown tools, invalid arguments, matching call IDs, replay of Responses output items, SSE item identity and sequence numbers, and failures without successful completion. Schema tests covered local and embedded references, blocked external resources, duplicate JSON keys, bounded nesting/numbers/schema complexity, and pathological numeric inputs. Image preparation reserves the request slot without holding the settings mutex; partial native sends issue best-effort cancellation. Hidden reasoning-only output is rejected instead of returning an empty success.
- Installer tests covered nine OS/browser layouts, input validation, read-only dry runs, preservation of all settings and the API key, explicit session/port overrides, foreign registrations, and symlink destinations.
- Fresh-install tests verified the official extension ID default and explicit custom-ID overrides, including exact allowed origins in both host configuration and browser registration. The manifest public key was parsed and its derived ID matched the installer default, `eegmaembfjajhifjbddmdbppchinmmcg`. The built macOS ARM64 executable also completed an ID-free Chromium installation dry run without writing files.
- All 32 UI behavior tests passed: thirteen for settings, eight for the popup, and eleven for custom selects. They cover validated drafts, save failures, busy/offline guards, timeout relationships, read-only discovery, key replacement, appearance, reconnect, storage failures, clipboard behavior, safe error rendering, and deferred status refresh without lost drafts. Select tests cover keyboard navigation, typeahead, cancellation, disabled options and ancestors, focus, event propagation, selection indicators, and viewport positioning. An older failed appearance write cannot roll back a newer preference update.
- The final feature verification ran `go mod verify`, `bridge-check`, `bridge-build`, and `bridge-release` inside `devenv shell`, with temporary module/build caches. All passed using Go 1.26.7. `devenv test` invokes the same check script.
- After standardizing the product name as XIPU AI Bridge and setting the initial extension version to `0.1.0`, `bridge-check`, `bridge-build`, and `bridge-release` passed again. The release archive and extracted acceptance copy use the updated name and version.
- After adding the store public key and default installer ID, the same three commands passed again. Release and extracted acceptance manifests retain version `0.1.0` and the matching public key.
- The settings page was inspected in the in-app browser with synthetic Chrome APIs at 1280px, 740px, and 390px widths, including light/dark themes and the offline state. No horizontal overflow was observed. Labels share the Frame heading inset, and controls align to the opposite edge. At 390px, switch rows keep labels and switches side by side; wider fields stack. The session dropdown aligns with its trigger's right edge at 740px, while menus remain within the viewport. Browser checks covered a single selected checkmark, End/Escape, typeahead/Enter, Tab dismissal and focus, disabled-session skipping, switch toggling, save/reload, session selection, and immediate theme changes. Offline native settings remain disabled while Appearance stays usable. Section navigation and invalid-field focus are covered by the settings tests.

## Artifact sizes

Initial October 8 acceptance snapshot, before the branding assets and installation archives were added. Build flags: `CGO_ENABLED=0`, `-trimpath`, `-ldflags='-s -w'`. Sizes are bytes for those local unsigned candidates; Go version and VCS metadata may affect later builds.

| Artifact | Bytes |
| --- | ---: |
| xipu-bridge-extension.zip | 33,801 |
| xipu-bridge_darwin_amd64 | 8,345,376 |
| xipu-bridge_darwin_arm64 | 7,770,386 |
| xipu-bridge_linux_amd64 | 8,196,258 |
| xipu-bridge_linux_arm64 | 7,602,338 |
| xipu-bridge_windows_amd64.exe | 8,410,624 |
| xipu-bridge_windows_arm64.exe | 7,668,736 |

All twelve SHA256SUMS entries in that snapshot were verified. That extension archive contained exactly 15 allowed runtime/style/license files, including the select controller, coss-ui MIT notice, and CC0 legal text. Release artifacts include the project license, third-party notice, and full dependency licenses. The host remains a standalone executable; pinned JSON Schema and WebP libraries are compiled into it.

## Release package verification

On October 9, the full repository checks and six-platform release build passed with the new logo and installation archives. Each versioned native archive includes a stable executable filename, a platform launcher, installation instructions, and licenses. All 18 local checksum entries passed verification. Package checks extracted all six archives into paths containing spaces and verified exact contents, source-file and binary byte equality, executable permissions, and absence of symlinks. POSIX launchers preserved quoted arguments and success/failure exit codes. The real macOS ARM64 executable completed a dry run against a canonical temporary home without writing configuration or browser registrations.

| Installation archive | Bytes |
| --- | ---: |
| xipu-ai-bridge_0.1.0_macos_arm64.zip | 3,193,141 |
| xipu-ai-bridge_0.1.0_macos_amd64.zip | 3,468,793 |
| xipu-ai-bridge_0.1.0_linux_arm64.tar.gz | 3,094,453 |
| xipu-ai-bridge_0.1.0_linux_amd64.tar.gz | 3,437,472 |
| xipu-ai-bridge_0.1.0_windows_arm64.zip | 3,117,983 |
| xipu-ai-bridge_0.1.0_windows_amd64.zip | 3,498,607 |

The extension ZIP is 39,679 bytes and includes the new SVG plus five PNG icon sizes. The macOS executable has a Go linker ad hoc signature, with no Developer ID identity or team identifier. No Apple notarization or Windows Authenticode signing was performed.

The release workflow's YAML and local asset-preparation step were checked, including rejection of a tag that differs from the extension version. These local checks did not exercise GitHub publication. Windows launcher execution is wired into Windows CI with an isolated profile and dry-run arguments; it has not run on this macOS host. Download quarantine, OS trust prompts, and fresh Windows/Linux browser installations still require platform acceptance testing.

The image upload contract was checked against the school's public [Upload component](https://tosai.xjtlu.edu.cn/assets/assets/Upload-DmPRipa7.js) and saved frontend helpers. The page sends multipart `accept=image`, `file`, and `lang` to `/api/common/upload`, reads `data.url` or `data.file_url`, and passes the resulting ordered URL array as completion `files`. This is source evidence, not a live upload result.

## Installed-host acceptance

The macOS ARM64 release was installed into the per-user configuration directory after backing up a previous host installation and Chrome registration. The installed executable matched the release binary byte for byte. The runtime directory uses mode `0700`; configuration and Native Messaging registration use `0600`. Registration authorizes only `chrome-extension://eegmaembfjajhifjbddmdbppchinmmcg/`.

The fixed-ID unpacked extension launched the installed Go host through Chrome Native Messaging. The loopback health endpoint returned `ok: true` and transport `native-messaging`. Unauthenticated requests to `/v1/models`, `/v1/chat/completions`, and `/v1/responses` each returned HTTP 401.

The school tab initially displayed Chrome's `ERR_BLOCKED_BY_CLIENT` navigation error and the host reported zero connected tabs. Restarting Chrome restored access and the extension reconnected with one tab. The blocking component was not identified; a read-only source review found no navigation or request-blocking APIs in the extension.

Live API acceptance then used an existing dedicated school conversation with Context Count 0 and an empty system prompt. The school catalog returned 21 models. Only generated test prompts, synthetic tool results, and generated color images were sent; credentials were not included in test output.

| Live check | Model | Result |
| --- | --- | --- |
| Chat Completions JSON and SSE | `qwen3.6-27b` | Passed exact text, response identity, finish reason, and terminal event checks |
| Responses JSON Schema | `qwen3.6-27b` | Passed completed-response and schema checks |
| Responses text SSE | `qwen3.6-27b` | Passed event ordering, item identity, text, and final-state checks |
| Chat Completions function-call round trip | `qwen3.6-27b` | Passed function/argument checks and replay of a receipt disclosed only in the tool result |
| Responses function-call round trip | `qwen3.6-27b` | Passed typed argument SSE, call-ID matching, and stateless result replay |
| Chat Completions image, 64 x 32 PNG | `gpt-5.4-nano` | Failed visual answer: white/orange image was answered black/white |
| Chat Completions image, 512 x 256 PNG | `gpt-5.4-nano` | Failed visual answer: green/black image was answered green/green |
| Chat Completions image, 512 x 256 PNG | `gpt-5.6-luna` | Passed random left/right color identification |
| Responses image, 512 x 256 PNG | `gpt-5.6-luna` | Passed random left/right color identification and final response checks |
| Request/session model mismatch | Qwen request with a nano session | Rejected before generation |
| Image capability guard | `qwen3.6-27b` | Rejected before upload or generation |

This run made twelve model generations: eight with Qwen, two with nano, and two with luna. The image attachments were uploaded to school storage and were not deleted. The two nano trials completed upload and returned text but failed visual correctness: the stored first attachment displayed the correct colors, and both API image formats passed with luna. These observations do not establish why nano answered incorrectly or guarantee another model's visual accuracy.

The school conversation was restored to `qwen3.6-27b`. Final health was `ok: true`, `busy: false`, `tabs: 1`, with Native Messaging transport. The local host remains configured to use the existing conversation name.

## Not established by these checks

- Store installation has not been tested; this acceptance used the fixed-ID unpacked Chrome extension.
- Live tool/schema checks establish successful examples of the bridge's prompted compatibility protocol, not school-native tool calling, constrained decoding, or reliability across all models and prompts. The model requested only a synthetic function; no model-selected executable or arbitrary tool was run.
- Live vision checks covered one PNG per request supplied as a data URL. Multiple images, public HTTPS image retrieval, other image formats, maximum server attachment limits, and cancellation during upload remain covered only by synthetic tests or unverified at the school boundary. SSE checks validated completed event sequences, not time-to-first-token or delivery latency.
- Windows/Linux browser startup and macOS x86-64 hardware were not exercised. Cross-compilation and mocked registration tests do not establish platform runtime support. CI is configured, but no hosted CI run was performed.
- Settings are written to a temporary file before replacement. Go's `os.Rename` does not guarantee atomic replacement on Windows.
- Popup and settings previews use synthetic Chrome APIs on ordinary local pages. They do not prove store installation or native registration. Chrome preview tab creation did not complete; current visual checks used the in-app browser.
- Binaries are unsigned release candidates, not signed/notarized installers or a published browser-store extension.
- Only one browser/profile can bind the configured API port. An explicit request model overrides the configured default, but the selected school session must already use that model with context count zero. Settings inspection is read-only; the bridge does not change the school session's model or generate a reply while inspecting it.

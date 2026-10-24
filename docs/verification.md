# Testing and verification

Run the full test and verification suite inside the pinned development shell:

```sh
devenv shell -- bridge-check
devenv shell -- bridge-build
devenv shell -- bridge-release
devenv shell -- bash packaging/check.sh
```

## Automated test coverage

| Area | What is tested |
| --- | --- |
| Go host | `gofmt`, `go vet`, unit tests, and the race detector on macOS and Linux |
| HTTP & streaming | Bearer authentication, loopback host enforcement, Chat Completions and Responses JSON/SSE formatting, optional `[DONE]` markers, clean EOF handling, truncated SSE frames, stream read errors, client disconnects, and timeouts |
| Client compatibility | Accepted token-limit parameters (`max_tokens`, `max_completion_tokens`, `max_output_tokens`), invalid/conflicting values, `X-XIPU-Ignored-Parameters` and `X-XIPU-Usage` headers, `usage: null` chunks, and CORS preflight/exposed headers |
| Native Messaging | Length-prefixed framing, 256 KiB chunks with a 24 MiB reassembly limit, out-of-order/oversized chunk rejection, host disconnects, reconnects without replaying in-flight requests, and clean shutdown |
| End-to-end extension bridge | A real Go host subprocess communicating through the background service worker, isolated content script, and main-world page script against a mock XIPU AI server |
| Session & model safety | Automatic model switching without clobbering unrelated session fields, post-update session ID and Context Count 0 verification, prompt preservation, no automatic retries, and keeping the XIPU AI token inside the browser |
| First-run setup | Explicit session creation, 3-second pacing before configuration, Context Count 0 and empty prompt verification, persisted progress across interruptions, read-only recovery after HTTP 502, user cancellation, and manual fallback via Settings |
| Image inputs | PNG/JPEG/GIF/WebP header and raster decoding, size/dimension limits, SSRF-safe public HTTPS downloads, multipart uploads, pre-flight multimodal capability checks, and optional omission of earlier answered images |
| Document inputs | Responses `input_file` and Chat Completions `file` parts, PDF signature and UTF-8 text validation, public HTTPS file downloads, mixed image/document ordering, `/chat` frontend enforcement, and halting on the first failed upload |
| Tools & structured output | Prompt-based function call round trips, call-ID matching, JSON Schema argument validation, `json_object` and `json_schema` output validation, complexity bounds, and blocking external schema URLs |
| Extension UI | Form validation, save failures, offline/busy state locking, API key masking and rotation, theme persistence and rollback, clipboard fallbacks, and accessible combobox keyboard navigation |
| XIPU AI frontends | Separate `/chat` and `/v3/chat` token stores, model catalog and completion endpoints, 10-attachment (`/chat`) vs. 1-image (`/v3/chat`) limits, non-chat URL rejection, and legacy webpage send flow checks |
| Installer & packaging | Per-OS Native Messaging manifest paths, Linux Brave and Chromium env-var precedence, custom `--native-host-dir` lifecycle, symlink protection, config/key preservation across upgrades, launcher argument forwarding, archive contents, file permissions, and SHA-256 checksums |

All automated tests run offline against synthetic credentials, sessions, and mocked responses—no live XIPU AI account is needed.

GitHub Actions runs the suite on macOS, Linux, and Windows, cross-compiles release archives for ARM64 and x86-64, and publishes tagged releases only when all checks pass and the Git tag matches `extension/manifest.json`.

## Scope and limitations of automated tests

- **Upstream API changes:** Mocked integration tests verify the bridge's contract against known XIPU AI `/chat` and `/v3/chat` behavior, but cannot catch unannounced changes to the live university service, login flow, or campus proxy.
- **Browser packaging:** Cross-compilation and manifest path tests do not replace testing inside actual browser installations, especially for sandboxed Linux packages (Snap or Flatpak) that restrict host filesystem access.
- **OS security prompts:** Prebuilt binaries are unsigned and unnotarized, so macOS Gatekeeper and Windows SmartScreen behavior must be handled at the OS level.
- **Model behavior:** Validating file uploads, image transport, or prompt-based tool/schema envelopes only guarantees that the bridge sent and checked the payload—how accurately a specific model interprets an image, PDF, or tool definition depends on the upstream model and XIPU AI's backend pipeline.
- **Single-instance port binding:** Only one browser profile can bind the configured local TCP port at a time. On Windows, config file updates use `os.Rename`, which is not guaranteed to be strictly atomic across concurrent processes.

See the [API reference](reference.md#api) and [platform notes](reference.md#platforms-and-release-limits) for full operational details.

## Live document upload checks

On 2026-10-23, live checks were run against `/chat` (`gpt-5.6-luna`) using small synthetic files containing independent verification codes and numeric tables:

| Test case | Result |
| --- | --- |
| Text-layer PDF via Responses `input_file` | HTTP 200 — verification code, row values, and sum returned accurately |
| Text-layer PDF via Chat Completions `file` | HTTP 200 — verification code and calculated total returned accurately |
| PDF + TXT together via Responses | HTTP 200 — both files read and combined total calculated accurately |
| Scanned (image-only) PDF via Responses | HTTP 200 — OCR extracted printed text and numbers, but shape colors were not visible to the model |
| Same scanned page sent as PNG via Responses | HTTP 200 — text, numbers, shape order, and colors all identified accurately |
| Three documents in one streaming Responses call | HTTP 502 during upload — XIPU AI storage returned an upstream `libcurl` HTTPS error before generation started |

In this comparison, the scanned PDF exposed printed text and numbers but not the visual details recognized from the PNG. This suggests document parsing can expose OCR text without page images; it does not establish how every document or model is processed. For tasks involving diagrams or colors, send the relevant page as an image to a model that supports images.

Separate webpage checks also failed partway through a PDF-and-TXT upload before generation. The successful two-file API check establishes that multiple documents can work, not consistent upload availability. Neither path automatically retried failed uploads. Long or encrypted PDFs and live generation with three documents remain unverified.

Live image checks covered one image through Responses and two ordered images through Chat Completions. The webpage's 10-attachment picker limit was checked on 2026-10-24; successful generation with all ten attachments remains unverified.

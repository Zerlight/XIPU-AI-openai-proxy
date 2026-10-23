# Testing and verification

Run the repository checks in the pinned development environment:

```sh
devenv shell -- bridge-check
devenv shell -- bridge-build
devenv shell -- bridge-release
devenv shell -- bash packaging/check.sh
```

## Automated coverage

| Area | Coverage |
| --- | --- |
| Go | Formatting, vet, unit tests, and the race detector on macOS/Linux |
| HTTP and streaming | Authentication, loopback checks, Chat Completions and Responses JSON/SSE, optional school completion markers, clean EOF, incomplete frames, read failures, cancellation, and timeouts |
| Client compatibility | Accepted token-limit fields, invalid and conflicting values, ignored-parameter headers, unknown usage, and CORS header access |
| Native Messaging | Framing, bounded chunk assembly, ordering, disconnects, reconnect without replay, and clean shutdown |
| Extension integration | A real Go subprocess connected through background, isolated content, and page scripts using a synthetic school API |
| School request boundaries | Automatic model updates preserving other settings, saved model/session-ID verification, Context Count 0, unchanged compatibility prompts, no automatic retries, and school-token containment |
| First-run setup | Explicit creation, paced configuration, verified isolation settings, persistent progress, read-only recovery after HTTP 502, cancellation and late-reply handling, manual settings recovery, and no generation during setup |
| Images | PNG/JPEG/GIF/WebP validation, size limits, safe public HTTPS retrieval, multipart upload, typed capability errors before generation, opt-in answered-history omission, and current-image protection |
| Files | Responses `input_file`, Chat Completions `file`, PDF/UTF-8 text validation, bounded public HTTPS downloads, mixed attachment ordering, retained document history, legacy frontend rejection, and stopping after partial upload failure |
| Tools and structured output | Function-call round trips, call-ID matching, argument validation, JSON Schema output, bounded schema processing, and blocked external resources |
| Settings and UI | Validated drafts, persistence failures, busy/offline states, key rotation, theme changes, clipboard errors, select keyboard behavior, and focus handling |
| School frontends | Separate `/chat` and `/v3/chat` login stores, model catalogs and generation payloads; dedicated-session checks; limits of 10 attachments on `/chat` and one image on `/v3/chat` before school requests; rejection of non-chat routes; native-host integration for both protocols |
| Installation and packaging | OS/browser registration layouts, Linux Brave paths, Chromium environment precedence, custom manifest directories, symlink protection, configuration preservation, argument quoting, launcher exit status, archive contents, permissions, checksums, and extension identity |

Fixtures use synthetic credentials, sessions, model names, and responses. The automated suite does not require a school login or make live generation requests.

The CI workflow runs checks on macOS, Linux, and Windows. Release builds target ARM64 and x86-64 on each platform. Tagged releases are published only after the required jobs pass and the tag matches the extension version.

## Verification limits

- Synthetic integration tests cannot establish compatibility with changes to the live school service. Browser startup, authentication, proxy behavior, model updates, and model capabilities need separate end-to-end verification. Session verification cannot prevent a concurrent edit from another client or the school interface.
- Cross-compilation and installer tests do not establish browser-level support on every OS, architecture, or browser distribution. Snap and Flatpak installations may require additional native-host integration.
- Download quarantine, OS trust prompts, signing, and notarization are outside unit-test coverage. Native packages are unsigned.
- UI fixtures simulate browser extension APIs. They do not verify browser-store installation or native-host registration.
- Successful image transport does not establish a model's visual accuracy. Prompt-based tools and structured output do not provide school-native function calling or constrained decoding.
- Live `/chat` image checks cover a single image through Responses and two ordered images through Chat Completions with an image-capable model. The official chat uploader's 10-attachment limit was checked on 2026-10-24; generation with all ten attachments remains unverified. File-picker limits do not establish server capacity.
- SSE event validation does not establish time-to-first-token or delivery latency. Accepted token-limit fields do not enforce generation or spending limits; token usage remains unavailable.
- Only one browser/profile can bind the configured API port. Settings replacement uses Go's `os.Rename`, which does not guarantee atomic replacement on Windows.

See the [API reference](reference.md#api) and [platform limits](reference.md#platforms-and-release-limits) for supported behavior.

## Live document checks

Checks on 2026-10-23 used small synthetic files with independent verification codes and known numeric totals. API requests selected `gpt-5.6-luna` through `/chat`; document processing may use a separate school pipeline.

| Input and route | Result |
| --- | --- |
| Text-layer PDF, Responses `input_file` | HTTP 200; verification code, table row values, and total correct |
| Text-layer PDF, Chat Completions `file` | HTTP 200; verification code and calculated total correct |
| PDF + TXT, Responses | HTTP 200; both files correctly identified and combined totals correct |
| Image-only PDF, Responses | HTTP 200; printed code and numbers recognized, colored shapes unavailable |
| Same image-only sheet as PNG, Responses | HTTP 200; code, numbers, shape order, and colors correct |
| Three documents, streaming Responses | HTTP 502 during upload; school storage reported a libcurl HTTPS protocol error before generation |

Separate webpage checks confirmed PDF text extraction and scanned-text recognition. Uploading a PDF and a TXT file together through the webpage also failed partway through, before generation. The successful two-file API check shows that multiple document inputs can work, but does not establish consistent upload availability. Neither path automatically retried failed uploads.

The scanned fixture contained one raster image and no extractable text. Comparing its PDF and PNG results indicates that document parsing can expose OCR text without embedded visual details. For tasks requiring diagrams or color recognition, send the relevant page as an image to a model that advertises image support. Broader document-format coverage, long or encrypted PDFs, and live streaming with three documents remain unverified.

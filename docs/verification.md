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
| Tools and structured output | Function-call round trips, call-ID matching, argument validation, JSON Schema output, bounded schema processing, and blocked external resources |
| Settings and UI | Validated drafts, persistence failures, busy/offline states, key rotation, theme changes, clipboard errors, select keyboard behavior, and focus handling |
| Installation and packaging | OS/browser registration layouts, configuration preservation, argument quoting, launcher exit status, archive contents, permissions, checksums, and extension identity |

Fixtures use synthetic credentials, sessions, model names, and responses. The automated suite does not require a school login or make live generation requests.

The CI workflow runs checks on macOS, Linux, and Windows. Release builds target ARM64 and x86-64 on each platform. Tagged releases are published only after the required jobs pass and the tag matches the extension version.

## Verification limits

- Synthetic integration tests cannot establish compatibility with changes to the live school service. Browser startup, authentication, proxy behavior, model updates, and model capabilities need separate end-to-end verification. Session verification cannot prevent a concurrent edit from another client or the school interface.
- Cross-compilation and installer tests do not establish browser-level support on every OS, architecture, or browser distribution. Snap and Flatpak installations may require additional native-host integration.
- Download quarantine, OS trust prompts, signing, and notarization are outside unit-test coverage. Native packages are unsigned.
- UI fixtures simulate browser extension APIs. They do not verify browser-store installation or native-host registration.
- Successful image transport does not establish a model's visual accuracy. Prompt-based tools and structured output do not provide school-native function calling or constrained decoding.
- SSE event validation does not establish time-to-first-token or delivery latency. Accepted token-limit fields do not enforce generation or spending limits; token usage remains unavailable.
- Only one browser/profile can bind the configured API port. Settings replacement uses Go's `os.Rename`, which does not guarantee atomic replacement on Windows.

See the [API reference](reference.md#api) and [platform limits](reference.md#platforms-and-release-limits) for supported behavior.

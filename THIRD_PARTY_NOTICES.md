# Third-party notices

This project's original code and documentation are dedicated to the public domain under CC0 1.0. The following third-party libraries are compiled into the native executable and retain their respective licenses:

| Dependency | Version | Purpose | License |
| --- | --- | --- | --- |
| [santhosh-tekuri/jsonschema](https://github.com/santhosh-tekuri/jsonschema) | v6.0.3 | JSON Schema compilation and validation | [Apache-2.0](licenses/jsonschema.txt) |
| [golang.org/x/image](https://pkg.go.dev/golang.org/x/image) | v0.46.0 | WebP image decoding | [BSD-3-Clause](licenses/x-image.txt) |
| [golang.org/x/text](https://pkg.go.dev/golang.org/x/text) | v0.42.0 | Transitive dependency for JSON Schema validation | [BSD-3-Clause](licenses/x-text.txt) |

All Go dependencies are used unmodified; exact versions and checksums are pinned in `go.mod` and `go.sum`.

The browser extension's UI styles are adapted from coss-ui under the MIT License. The license text is included at `extension/styles/LICENSE.coss.txt` (and `styles/LICENSE.coss.txt` inside the extension archive), with component sources and adaptation details documented in `docs/coss-ui-provenance.md`.

# Third-party notices

CC0 applies to this project's original material. The following dependencies retain their own licenses. They are compiled into the native executable and do not require a separately installed runtime.

| Dependency | Version | Purpose | License |
| --- | --- | --- | --- |
| [santhosh-tekuri/jsonschema](https://github.com/santhosh-tekuri/jsonschema) | v6.0.3 | JSON Schema compilation and validation | [Apache-2.0](licenses/jsonschema.txt) |
| [golang.org/x/image](https://pkg.go.dev/golang.org/x/image) | v0.46.0 | WebP image decoding | [BSD-3-Clause](licenses/x-image.txt) |
| [golang.org/x/text](https://pkg.go.dev/golang.org/x/text) | v0.42.0 | Transitive dependency of JSON Schema validation | [BSD-3-Clause](licenses/x-text.txt) |

The Go dependencies are used without source modifications. Versions and checksums are recorded in `go.mod` and `go.sum`.

The extension's adapted coss-ui styles retain their MIT license. The notice is in `extension/styles/LICENSE.coss.txt` in this repository and `styles/LICENSE.coss.txt` inside the extension ZIP. Sources and adaptations are recorded in `docs/coss-ui-provenance.md` in the source repository.

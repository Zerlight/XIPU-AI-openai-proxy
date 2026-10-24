# Development

See [README.md](README.md) for installation, API usage, and compatibility notes, and [docs/reference.md](docs/reference.md) for full architecture and configuration details.

- Run `devenv shell -- bridge-check` to check formatting, run static analysis, and execute the test suite.
- Run `devenv shell -- bridge-build` to compile the local binary, or `devenv shell -- bridge-release` to build release archives.
- Never commit credentials, local configuration files, or build artifacts.
- Keep `THIRD_PARTY_NOTICES.md` and `licenses/` up to date when adding or updating third-party code.

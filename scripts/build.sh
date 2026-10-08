#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
suffix=""
if [[ "$(go env GOOS)" == "windows" ]]; then suffix=".exe"; fi
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "dist/xipu-bridge${suffix}" ./cmd/xipu-bridge

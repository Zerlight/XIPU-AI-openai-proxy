#!/usr/bin/env bash
# Build unsigned release candidates. This does not publish or sign anything.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/icons.sh
mkdir -p dist/release
release_dir="$(pwd)/dist/release"
artifacts=()
for target in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64 windows/arm64 windows/amd64; do
  target_os="${target%/*}"
  target_arch="${target#*/}"
  filename="xipu-bridge_${target_os}_${target_arch}"
  if [[ "$target_os" == "windows" ]]; then filename+=".exe"; fi
  CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" go build -trimpath -ldflags='-s -w' -o "$release_dir/$filename" ./cmd/xipu-bridge
  artifacts+=("$filename")
done

# Explicit inputs prevent developer config, credentials, or test transcripts
# from accidentally entering the browser-store package.
extension_files=(manifest.json background.js bridge.js page.js popup.html popup.js options.html options.js ui-settings.js ui-controls.js styles/coss.css styles/popup.css styles/options.css styles/LICENSE.coss.txt)
while IFS= read -r -d '' icon; do
  extension_files+=("${icon#extension/}")
done < <(find extension -type f \( -path 'extension/icons/*.png' -o -path 'extension/icons/*.svg' \) -print0)
for notice in LICENSE THIRD_PARTY_NOTICES.md; do
  if [[ -f "extension/$notice" ]]; then extension_files+=("$notice"); fi
done
extension_zip="$release_dir/xipu-bridge-extension.zip"
# zip updates existing archives, so create a fresh archive to exclude stale files.
rm -f "$extension_zip"
(cd extension && zip -q -X "$extension_zip" "${extension_files[@]}")
artifacts+=(xipu-bridge-extension.zip)

# Keep license terms beside standalone binaries in every release artifact set.
cp LICENSE THIRD_PARTY_NOTICES.md "$release_dir/"
mkdir -p "$release_dir/licenses"
for notice in licenses/*.txt; do
  cp "$notice" "$release_dir/$notice"
  artifacts+=("$notice")
done
artifacts+=(LICENSE THIRD_PARTY_NOTICES.md)
# Original extension code uses the repository's CC0 dedication.
zip -q -X -j "$extension_zip" LICENSE

(cd "$release_dir" && sha256sum "${artifacts[@]}" > SHA256SUMS)
printf 'Unsigned build candidates and checksums: %s\n' "$release_dir"

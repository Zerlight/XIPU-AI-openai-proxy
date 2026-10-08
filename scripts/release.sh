#!/usr/bin/env bash
# Build unsigned release candidates. This does not publish or sign anything.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/icons.sh
mkdir -p dist/release
release_dir="$(pwd)/dist/release"
version="$(node -p 'require("./extension/manifest.json").version')"
if [[ ! "$version" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]]; then
  printf 'Invalid extension version for packaging: %s\n' "$version" >&2
  exit 1
fi
package_root="$(mktemp -d "${TMPDIR:-/tmp}/xipu-packages.XXXXXX")"
trap 'rm -rf "$package_root"' EXIT
artifacts=()
for target in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64 windows/arm64 windows/amd64; do
  target_os="${target%/*}"
  target_arch="${target#*/}"
  filename="xipu-bridge_${target_os}_${target_arch}"
  if [[ "$target_os" == "windows" ]]; then filename+=".exe"; fi
  CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" go build -trimpath -ldflags='-s -w' -o "$release_dir/$filename" ./cmd/xipu-bridge
  artifacts+=("$filename")

  package_os="$target_os"
  native_name=xipu-bridge
  case "$target_os" in
    darwin) package_os=macos; launcher=Install.command; archive_type=zip ;;
    windows) native_name+=.exe; launcher=Install.cmd; archive_type=zip ;;
    linux) launcher=install.sh; archive_type=tar.gz ;;
  esac
  package_name="xipu-ai-bridge_${version}_${package_os}_${target_arch}"
  package_dir="$package_root/$package_name"
  mkdir -p "$package_dir/licenses"
  cp "$release_dir/$filename" "$package_dir/$native_name"
  cp "packaging/$launcher" packaging/INSTALL.md LICENSE THIRD_PARTY_NOTICES.md "$package_dir/"
  cp licenses/*.txt "$package_dir/licenses/"
  chmod 755 "$package_dir/$native_name"
  if [[ "$target_os" != windows ]]; then chmod 755 "$package_dir/$launcher"; fi
  archive="$package_name.$archive_type"
  rm -f "$release_dir/$archive"
  if [[ "$archive_type" == zip ]]; then
    (cd "$package_root" && zip -q -X -r "$release_dir/$archive" "$package_name")
  else
    COPYFILE_DISABLE=1 tar -czf "$release_dir/$archive" -C "$package_root" "$package_name"
  fi
  artifacts+=("$archive")
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

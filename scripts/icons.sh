#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p extension/icons
cp design/logo/xipu-ai-bridge.svg extension/icons/bridge.svg

icon_source=$(mktemp)
trap 'rm -f "$icon_source"' EXIT
# A light keyline keeps the dark symbol visible on dark browser toolbars.
sed 's/<path fill=/<path stroke="#fff" stroke-width="1" stroke-linejoin="round" paint-order="stroke" fill=/' \
  design/logo/xipu-ai-bridge.svg > "$icon_source"
for size in 16 24 32 48 128; do
  resvg --width "$size" --height "$size" "$icon_source" "extension/icons/icon-$size.png"
done

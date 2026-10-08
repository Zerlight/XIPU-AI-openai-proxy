#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

unformatted=$(gofmt -l cmd internal)
if [[ -n "$unformatted" ]]; then
  printf 'Run bridge-format; these Go files need formatting:\n%s\n' "$unformatted" >&2
  exit 1
fi
go vet ./...
if [[ "$(go env GOOS)" == "windows" ]]; then
  go test ./...
else
  go test -race ./...
fi
for file in extension/*.js tests/*.test.cjs; do
  node --check "$file"
done
for file in tests/*.test.cjs; do
  node "$file"
done

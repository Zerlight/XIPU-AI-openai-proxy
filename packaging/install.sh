#!/bin/sh
CDPATH= cd -- "$(dirname -- "$0")" || exit 1
exec ./xipu-bridge install "$@"

#!/bin/sh
CDPATH= cd -- "$(dirname -- "$0")" || exit 1
./xipu-bridge install "$@"
xipu_status=$?
if [ "$xipu_status" -ne 0 ]; then
  printf '\nInstallation failed. Read the error above.\n'
fi
if [ -t 0 ]; then
  printf '\nPress Return to close this window.'
  read -r xipu_reply || true
fi
exit "$xipu_status"

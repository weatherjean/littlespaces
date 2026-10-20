#!/bin/sh
set -eu
umask 077
if [ -f /run/secrets/browser_token ]; then
  LITTLESPACES_BROWSER_TOKEN="$(cat /run/secrets/browser_token)"
  export LITTLESPACES_BROWSER_TOKEN
fi
if [ "${1:-}" = serve ] && [ ! -e "$2" ]; then
  little-spaces init "$2"
fi
exec little-spaces "$@"

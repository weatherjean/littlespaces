#!/bin/sh
set -eu
umask 077
LITTLESPACES_BROWSER_TOKEN="$(cat /run/secrets/browser_token)"
export LITTLESPACES_BROWSER_TOKEN
exec node /opt/littlespaces/web/browser-harness.mjs

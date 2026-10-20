#!/bin/sh
set -eu
exec curl --fail --silent --show-error --max-time 5 \
  -H "Host: ${LITTLESPACES_AUTHORITY}" http://127.0.0.1:5175/health/ready

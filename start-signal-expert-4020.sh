#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
if ! command -v node >/dev/null 2>&1; then
  printf '\nNode.js 22.5 or newer is required. Download it from https://nodejs.org/\n\n' >&2
  exit 1
fi
exec node launcher.mjs --instance phase2 --port 4020 --strict-port --database data/instances/phase2/signal-expert.db --stream

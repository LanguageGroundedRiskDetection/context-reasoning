#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if command -v node >/dev/null 2>&1; then
  exec node server.js
fi

BUNDLED_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [ -x "$BUNDLED_NODE" ]; then
  exec "$BUNDLED_NODE" server.js
fi

echo "Could not find Node.js."
echo "Install Node.js or run with the Codex bundled runtime if available:"
echo "$BUNDLED_NODE server.js"
exit 1

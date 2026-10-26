#!/bin/sh
# Author: jperch1987
# Prefer installed runtimes; Codex's bundled runtimes are a local fallback.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

bundled_runtime="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if command -v node >/dev/null 2>&1; then
  node_executable=$(command -v node)
elif [ -x "$bundled_runtime/node/bin/node" ]; then
  node_executable="$bundled_runtime/node/bin/node"
else
  echo "Install a supported Node.js LTS release (22 or 24), then run this script again." >&2
  exit 1
fi

if [ -z "${PYTHON:-}" ]; then
  if [ -x .venv/bin/python ]; then
    PYTHON="$PWD/.venv/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    PYTHON=$(command -v python3)
  elif [ -x "$bundled_runtime/python/bin/python3" ]; then
    PYTHON="$bundled_runtime/python/bin/python3"
  else
    echo "Python 3.11+ is required. Install Python or set PYTHON to its executable path." >&2
    exit 1
  fi
  export PYTHON
fi

exec "$node_executable" server.mjs

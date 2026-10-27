#!/bin/sh
# Author: jperch1987
# Start with the runtimes remembered by install.sh; no activation is necessary.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

platform=unix
if [ -n "${WSL_DISTRO_NAME:-}${WSL_INTEROP:-}" ] || { [ -r /proc/sys/kernel/osrelease ] && grep -qi microsoft /proc/sys/kernel/osrelease; }; then
  platform=wsl
fi
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) echo 'Use PowerShell: .\start.ps1 (or use this script inside WSL).' >&2; exit 1 ;;
esac
node_executable=''
if [ -f ".state/node-$platform" ]; then node_executable=$(cat ".state/node-$platform"); fi
if [ ! -x "$node_executable" ]; then node_executable=$(command -v node || true); fi
if [ -z "$node_executable" ] || ! "$node_executable" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 && process.platform !== "win32" ? 0 : 1)'; then
  echo 'Node.js 22+ is required. Run bash install.sh --install-runtimes.' >&2
  exit 1
fi

if [ -z "${PYTHON:-}" ]; then
  if [ -f ".state/python-$platform" ]; then
    PYTHON=$(cat ".state/python-$platform")
  elif [ "$platform" = wsl ] && [ -x "$HOME/.venvs/aws-profile-switcher-wsl/bin/python" ]; then
    PYTHON="$HOME/.venvs/aws-profile-switcher-wsl/bin/python"
  elif [ "$platform" != wsl ] && [ -x .venv/bin/python ]; then
    PYTHON="$PWD/.venv/bin/python"
  else
    echo 'Set up the app first: bash install.sh' >&2
    exit 1
  fi
fi
if ! "$PYTHON" -c 'import sys, boto3; assert sys.version_info >= (3, 11) and sys.platform != "win32"' >/dev/null 2>&1; then
  echo 'The selected Python environment is unavailable or missing dependencies. Run bash install.sh, or correct PYTHON.' >&2
  exit 1
fi
export PYTHON
exec "$node_executable" server.mjs

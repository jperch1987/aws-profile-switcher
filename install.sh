#!/usr/bin/env bash
# Author: jperch1987
# Install app dependencies; optional runtimes come from package managers or nodejs.org.
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
app_dir=$PWD
install_runtimes=false
case "${1:-}" in
  --install-runtimes) install_runtimes=true ;;
  --help|-h)
    echo 'Usage: bash install.sh [--install-runtimes]'
    echo 'Installs app dependencies using Node.js 22+ and Python 3.11+.'
    echo 'The optional flag installs missing runtimes using existing Homebrew (Mac),'
    echo 'apt and an official Node.js 24 download (Debian/Ubuntu/WSL).'
    echo 'Native Windows: use .\install.ps1 [-InstallRuntimes] in PowerShell.'
    exit 0 ;;
  '') ;;
  *) echo 'Unknown option. Run bash install.sh --help.' >&2; exit 1 ;;
esac
[ "$#" -le 1 ] || { echo 'Too many arguments.' >&2; exit 1; }
system=$(uname -s)
platform=unix
case "$system" in
  Darwin|Linux) ;;
  MINGW*|MSYS*|CYGWIN*) echo 'Native Windows: run .\install.ps1 in PowerShell. For WSL, run this script inside your Linux distribution.' >&2; exit 1 ;;
  *) echo "Unsupported operating system: $system" >&2; exit 1 ;;
esac
if [ "$system" = Linux ] && { [ -n "${WSL_DISTRO_NAME:-}${WSL_INTEROP:-}" ] || { [ -r /proc/sys/kernel/osrelease ] && grep -qi microsoft /proc/sys/kernel/osrelease; }; }; then
  platform=wsl
fi
node_executable=''
python_executable=${PYTHON:-}
if [ -f ".state/node-$platform" ]; then node_executable=$(cat ".state/node-$platform"); fi
if [ ! -x "$node_executable" ]; then node_executable=$(command -v node || true); fi
if [ -z "$python_executable" ] && [ -f ".state/python-$platform" ]; then
  saved_python=$(cat ".state/python-$platform")
  if [ -x "$saved_python" ] && "$saved_python" -c 'import sys; assert sys.version_info >= (3, 11) and sys.platform != "win32"' >/dev/null 2>&1; then python_executable=$saved_python; fi
fi
if [ -z "$python_executable" ]; then python_executable=$(command -v python3 || true); fi
valid_node() {
  [ -n "$node_executable" ] && "$node_executable" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 && process.platform !== "win32" ? 0 : 1)' >/dev/null 2>&1
}
valid_python() {
  [ -n "$python_executable" ] && "$python_executable" -c 'import sys; assert sys.version_info >= (3, 11) and sys.platform != "win32"' >/dev/null 2>&1
}
if [ -n "${PYTHON:-}" ] && ! valid_python; then
  echo 'PYTHON must name a working Python 3.11+ executable for this operating system, without arguments.' >&2
  exit 1
fi
if [ "$install_runtimes" = true ]; then
  if [ "$system" = Darwin ]; then
    if ! valid_node || ! valid_python; then
      brew_executable=$(command -v brew || true)
      [ -n "$brew_executable" ] || { echo 'Install Homebrew from https://brew.sh, or install Node.js and Python from their official websites; then rerun this script.' >&2; exit 1; }
      if ! valid_node; then
        "$brew_executable" install node@24
        node_executable="$("$brew_executable" --prefix node@24)/bin/node"
      fi
      if ! valid_python; then
        "$brew_executable" install python@3.14
        python_executable="$("$brew_executable" --prefix python@3.14)/libexec/bin/python3"
      fi
    fi
  else
    if ! valid_python || ! "$python_executable" -c 'import venv, ensurepip' >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v xz >/dev/null 2>&1; then
      command -v apt-get >/dev/null 2>&1 || { echo 'Install Python 3.11+, its venv/pip packages, curl, and xz using your distribution package manager, then rerun.' >&2; exit 1; }
      echo 'Installing Linux prerequisites through apt (sudo may ask for your password).'
      sudo apt-get update
      sudo apt-get install -y python3 python3-venv python3-pip ca-certificates curl xz-utils
      if [ -z "${PYTHON:-}" ]; then python_executable=$(command -v python3); fi
    fi
    if ! valid_node; then
      case "$(uname -m)" in
        x86_64) node_arch=x64 ;;
        aarch64|arm64) node_arch=arm64 ;;
        *) echo 'Install Node.js 22+ for this Linux architecture from https://nodejs.org/en/download, then rerun.' >&2; exit 1 ;;
      esac
      valid_python || { echo 'This distribution supplies an older Python. Install Python 3.11+ or upgrade the distribution, then rerun.' >&2; exit 1; }
      download_dir=$(mktemp -d)
      trap 'rm -rf -- "$download_dir"' EXIT
      node_base=https://nodejs.org/dist/latest-v24.x
      echo 'Downloading official Node.js 24 for Linux into your home directory.'
      curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$node_base/SHASUMS256.txt" -o "$download_dir/SHASUMS256.txt"
      node_archive=$("$python_executable" -c 'import re,sys; rows=open(sys.argv[1]).read().splitlines(); names=[r.split()[1] for r in rows if re.fullmatch(r"[0-9a-f]{64}  node-v24\.[0-9]+\.[0-9]+-linux-"+sys.argv[2]+r"\.tar\.xz",r)]; assert len(names)==1; print(names[0])' "$download_dir/SHASUMS256.txt" "$node_arch")
      curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$node_base/$node_archive" -o "$download_dir/$node_archive"
      "$python_executable" -c 'import hashlib,pathlib,sys; root=pathlib.Path(sys.argv[1]); name=sys.argv[2]; expected=next(r.split()[0] for r in (root/"SHASUMS256.txt").read_text().splitlines() if r.split()[1]==name); assert hashlib.sha256((root/name).read_bytes()).hexdigest()==expected, "Node.js archive checksum mismatch"' "$download_dir" "$node_archive"
      runtime_root="$HOME/.local/share/aws-profile-switcher"
      runtime_dir="$runtime_root/${node_archive%.tar.xz}"
      node_executable="$runtime_dir/bin/node"
      if [ -e "$runtime_dir" ]; then
        valid_node && [ -x "$runtime_dir/bin/npm" ] || { echo "An incompatible runtime folder exists at $runtime_dir. Move it aside and retry." >&2; exit 1; }
      else
        mkdir -p "$runtime_root"
        tar -xJf "$download_dir/$node_archive" -C "$runtime_root"
      fi
    fi
  fi
fi
valid_node || { echo 'Node.js 22+ is required. Install it from https://nodejs.org/en/download or rerun with --install-runtimes.' >&2; exit 1; }
valid_python || { echo 'Python 3.11+ is required. Install it from https://python.org/downloads or rerun with --install-runtimes.' >&2; exit 1; }
node_executable=$("$node_executable" -p 'process.execPath')
export PATH="$(dirname -- "$node_executable"):$PATH"
command -v npm >/dev/null 2>&1 || { echo 'npm is missing. Install the complete Node.js distribution, which includes npm.' >&2; exit 1; }
if [ "$platform" = wsl ]; then
  venv_dir="$HOME/.venvs/aws-profile-switcher-wsl"
  "$python_executable" -c 'import pathlib,sys; p=pathlib.Path(sys.argv[1]).resolve(); assert not str(p).startswith("/mnt/"), "WSL HOME must be on the Linux filesystem, not /mnt"' "$venv_dir"
else
  venv_dir="$app_dir/.venv"
fi
venv_python="$venv_dir/bin/python"
if [ -e "$venv_dir" ]; then
  [ -x "$venv_python" ] || { echo "An incompatible or incomplete environment exists at $venv_dir. Move it aside and rerun; it has not been overwritten." >&2; exit 1; }
else
  echo "Creating Python environment: $venv_dir"
  "$python_executable" -m venv "$venv_dir" || { echo 'Python environment creation failed. On Debian/Ubuntu install python3-venv, then move aside the incomplete environment and rerun.' >&2; exit 1; }
fi
"$venv_python" -c 'import sys; assert sys.version_info >= (3, 11) and sys.prefix != sys.base_prefix and sys.platform != "win32"' || { echo 'The existing environment is incompatible. Move it aside and rerun.' >&2; exit 1; }
"$venv_python" -m pip install -r "$app_dir/requirements.txt"
"$venv_python" -c 'import boto3, botocore'
npm ci --ignore-scripts --no-audit --no-fund
mkdir -p .state
chmod 700 .state
printf '%s\n' "$venv_python" > ".state/python-$platform"
printf '%s\n' "$node_executable" > ".state/node-$platform"
chmod 600 ".state/python-$platform" ".state/node-$platform"
if [ ! -e profiles.txt ]; then cp profiles.example.txt profiles.txt; fi
echo 'Setup complete. Edit profiles.txt with your AWS role profiles, then run: bash start.sh'
echo 'Open http://127.0.0.1:3000 after starting the app. Existing profiles and AWS credentials are preserved.'

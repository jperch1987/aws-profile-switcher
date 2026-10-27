# Author: jperch1987
# Native Windows launcher; uses the environment saved by install.ps1.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot
if ($env:OS -ne 'Windows_NT') { throw 'Use bash start.sh on macOS or Linux/WSL.' }
$nodeExecutable = $null
if (Test-Path -LiteralPath '.state/node-windows.txt') {
    $nodeExecutable = (Get-Content -Raw -LiteralPath '.state/node-windows.txt').Trim()
}
if (-not $nodeExecutable -or -not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodeExecutable = $nodeCommand.Source }
}
if (-not $nodeExecutable) { throw 'Node.js was not found. Run .\install.ps1.' }
& $nodeExecutable -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 && process.platform === 'win32' ? 0 : 1)"
if ($LASTEXITCODE -ne 0) { throw 'Windows Node.js 22+ is required. Run .\install.ps1 -InstallRuntimes.' }
if (-not $env:PYTHON) {
    if (Test-Path -LiteralPath '.state/python-windows.txt') {
        $env:PYTHON = (Get-Content -Raw -LiteralPath '.state/python-windows.txt').Trim()
    } else {
        $env:PYTHON = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
    }
}
& $env:PYTHON -c "import sys, boto3; assert sys.version_info >= (3, 11) and sys.platform == 'win32'"
if ($LASTEXITCODE -ne 0) { throw 'The selected Python environment is unavailable or missing dependencies. Run .\install.ps1, or correct PYTHON.' }
& $nodeExecutable server.mjs
exit $LASTEXITCODE

# Author: jperch1987
# Native Windows installer. WSL users run bash install.sh inside Linux.
[CmdletBinding()]
param([switch]$InstallRuntimes)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot
if ($env:OS -ne 'Windows_NT') { throw 'Use bash install.sh on macOS or Linux/WSL.' }

function Test-Node([string]$Executable) {
    if (-not $Executable) { return $false }
    try {
        & $Executable -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 && process.platform === 'win32' ? 0 : 1)" 2>$null | Out-Null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}
function Test-Python([string]$Executable) {
    if (-not $Executable) { return $false }
    try {
        & $Executable -c "import sys; assert sys.version_info >= (3, 11) and sys.platform == 'win32'" 2>$null | Out-Null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}
function Find-Node {
    if (Test-Path -LiteralPath '.state/node-windows.txt') {
        $saved = (Get-Content -Raw -LiteralPath '.state/node-windows.txt').Trim()
        if (Test-Node $saved) { return $saved }
    }
    $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($command -and (Test-Node $command.Source)) { return $command.Source }
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($root) {
            $candidate = Join-Path $root 'nodejs/node.exe'
            if (Test-Node $candidate) { return $candidate }
        }
    }
    return $null
}
function Find-Python {
    if ($env:PYTHON) {
        if (-not (Test-Python $env:PYTHON)) { throw 'PYTHON must name a Windows Python 3.11+ executable, without arguments.' }
        return $env:PYTHON
    }
    if (Test-Path -LiteralPath '.state/python-windows.txt') {
        $saved = (Get-Content -Raw -LiteralPath '.state/python-windows.txt').Trim()
        if (Test-Python $saved) { return $saved }
    }
    $launcher = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($launcher) {
        try {
            $candidate = & $launcher.Source -3 -c 'import sys; print(sys.executable)' 2>$null
            if ($LASTEXITCODE -eq 0 -and $candidate -is [string] -and (Test-Python $candidate)) { return $candidate }
        } catch { }
    }
    $command = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($command -and (Test-Python $command.Source)) { return $command.Source }
    return $null
}
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed (exit $LASTEXITCODE). Correct the error above and rerun the installer." }
}
function Refresh-ProcessPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
}

$nodeExecutable = Find-Node
$pythonExecutable = Find-Python
if ($InstallRuntimes -and (-not $nodeExecutable -or -not $pythonExecutable)) {
    $winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $winget) { throw 'Install App Installer (WinGet) from Microsoft, or install Node.js and Python from their official websites, then rerun.' }
    if (-not $nodeExecutable) {
        Invoke-Checked $winget.Source @('install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--source', 'winget')
    }
    if (-not $pythonExecutable) {
        Invoke-Checked $winget.Source @('install', '--id', 'Python.Python.3.14', '--exact', '--source', 'winget')
    }
    Refresh-ProcessPath
    $nodeExecutable = Find-Node
    $pythonExecutable = Find-Python
}
if (-not $nodeExecutable) { throw 'Node.js 22+ is required. Install from https://nodejs.org/en/download or rerun with -InstallRuntimes. After a new installation, reopen PowerShell if needed.' }
if (-not $pythonExecutable) { throw 'Python 3.11+ is required. Install from https://python.org/downloads/windows or rerun with -InstallRuntimes. After a new installation, reopen PowerShell if needed.' }
$nodeExecutable = (& $nodeExecutable -p 'process.execPath').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the Node.js executable.' }
$env:Path = (Split-Path -Parent $nodeExecutable) + ';' + $env:Path
$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
if (-not $npm) { throw 'npm.cmd is missing. Install the complete Node.js distribution, which includes npm.' }
$venvDir = Join-Path $PSScriptRoot '.venv'
$venvPython = Join-Path $venvDir 'Scripts/python.exe'
if (Test-Path -LiteralPath $venvDir) {
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) { throw "An incompatible or incomplete environment exists at $venvDir. Move it aside and rerun; it has not been overwritten." }
} else {
    Invoke-Checked $pythonExecutable @('-m', 'venv', $venvDir)
}
Invoke-Checked $venvPython @('-c', "import sys; assert sys.version_info >= (3, 11) and sys.prefix != sys.base_prefix and sys.platform == 'win32'")
Invoke-Checked $venvPython @('-m', 'pip', 'install', '-r', (Join-Path $PSScriptRoot 'requirements.txt'))
Invoke-Checked $venvPython @('-c', 'import boto3, botocore')
Invoke-Checked $npm.Source @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
[IO.Directory]::CreateDirectory((Join-Path $PSScriptRoot '.state')) | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot '.state/python-windows.txt'), $venvPython + "`n", $utf8)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot '.state/node-windows.txt'), $nodeExecutable + "`n", $utf8)
if (-not (Test-Path -LiteralPath 'profiles.txt')) { Copy-Item -LiteralPath 'profiles.example.txt' -Destination 'profiles.txt' }
Write-Host 'Setup complete. Edit profiles.txt with your AWS role profiles, then run: .\start.ps1'
Write-Host 'Open http://127.0.0.1:3000 after starting the app. Existing profiles and AWS credentials are preserved.'

# Shared helpers for the Local Browser AI scripts. Dot-source: . "$PSScriptRoot\common.ps1"
# Compatible with Windows PowerShell 5.1 and PowerShell 7+.

$ErrorActionPreference = 'Stop'
$script:Root = Split-Path -Parent $PSScriptRoot
$script:Backend = Join-Path $Root 'backend'
$script:Extension = Join-Path $Root 'extension'
$script:VenvPython = Join-Path $Backend '.venv\Scripts\python.exe'

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "  [ok]   $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "  [warn] $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg) { Write-Host "  [fail] $msg" -ForegroundColor Red }
function Write-Info([string]$msg) { Write-Host "         $msg" -ForegroundColor Gray }

# Reads KEY=VALUE pairs from backend\.env (only LBA_* keys we care about).
function Get-EnvFileValue([string]$key, [string]$default) {
    $envFile = Join-Path $Backend '.env'
    $fromProcess = [Environment]::GetEnvironmentVariable($key)
    if ($fromProcess) { return $fromProcess }
    if (Test-Path $envFile) {
        foreach ($line in Get-Content $envFile) {
            if ($line -match "^\s*$key\s*=\s*(.*)\s*$") { return $Matches[1].Trim('"', "'", ' ') }
        }
    }
    return $default
}

function Get-BackendPort { [int](Get-EnvFileValue 'LBA_PORT' '8765') }
function Get-BackendUrl { "http://127.0.0.1:$(Get-BackendPort)" }
function Get-OllamaUrl { (Get-EnvFileValue 'LBA_OLLAMA_URL' 'http://127.0.0.1:11434').TrimEnd('/') }

function Get-DataDir {
    $d = Get-EnvFileValue 'LBA_DATA_DIR' ''
    if ($d) { return $d }
    if ($env:LOCALAPPDATA) { return (Join-Path $env:LOCALAPPDATA 'LocalBrowserAI') }
    return (Join-Path $HOME '.local\share\LocalBrowserAI')
}

function Get-RunDir {
    $d = Join-Path (Get-DataDir) 'run'
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    return $d
}

# Finds a Python >= 3.11. Returns @(exe, args...) or $null.
function Find-Python {
    $candidates = @(@('py', '-3.12'), @('py', '-3.13'), @('py', '-3.11'), @('python'), @('python3'))
    foreach ($c in $candidates) {
        $exe = $c[0]
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
        $cargs = @()
        if ($c.Length -gt 1) { $cargs = $c[1..($c.Length - 1)] }
        try {
            $v = & $exe @cargs -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
            if ($LASTEXITCODE -eq 0 -and $v) {
                $parts = $v.Trim().Split('.')
                if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 11) { return , (@($exe) + $cargs) }
            }
        } catch { }
    }
    return $null
}

function Find-Ollama {
    $cmd = Get-Command 'ollama' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $default = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path $default) { return $default }
    return $null
}

function Invoke-Json([string]$url, [int]$timeoutSec = 3, [hashtable]$headers = @{}) {
    try {
        return Invoke-RestMethod -Uri $url -TimeoutSec $timeoutSec -Headers $headers -UseBasicParsing
    } catch {
        return $null
    }
}

function Test-OllamaUp { $null -ne (Invoke-Json "$(Get-OllamaUrl)/api/version" 3) }
function Test-BackendUp { $null -ne (Invoke-Json "$(Get-BackendUrl)/api/v1/health" 3) }

# Returns the owning process of a listening TCP port (or $null).
function Get-PortOwner([int]$port) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($conn) { return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue }
    } catch { }
    return $null
}

function Get-CommandLine([int]$processId) {
    try { return (Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop).CommandLine } catch { return '' }
}

# PID files record ONLY processes started by start.ps1, so stop.ps1 never touches anything else.
function Save-Pid([string]$name, [int]$processId) { Set-Content -Path (Join-Path (Get-RunDir) "$name.pid") -Value $processId -Encoding ascii }
function Read-Pid([string]$name) {
    $f = Join-Path (Get-RunDir) "$name.pid"
    if (Test-Path $f) { return [int](Get-Content $f -Raw).Trim() }
    return $null
}
function Remove-Pid([string]$name) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path (Get-RunDir) "$name.pid") }

function Assert-Venv {
    if (-not (Test-Path $VenvPython)) {
        Write-Fail "Backend virtual environment not found ($VenvPython)."
        Write-Info 'Run scripts\install.ps1 first.'
        exit 1
    }
}

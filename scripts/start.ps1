<#
.SYNOPSIS
  Starts Ollama (if it is not already running) and the Local Browser AI backend,
  then verifies both. Processes it starts are recorded so stop.ps1 only stops those.
.PARAMETER ShowToken  Print the API token for manual pairing.
.PARAMETER NoOllama   Do not try to start Ollama.
#>
param([switch]$ShowToken, [switch]$NoOllama)
. "$PSScriptRoot\common.ps1"
Assert-Venv

$port = Get-BackendPort
$backendUrl = Get-BackendUrl
$ollamaUrl = Get-OllamaUrl
$logDir = Join-Path (Get-DataDir) 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 1. Ollama ----------------------------------------------------------------
Write-Step "Checking Ollama at $ollamaUrl"
if (Test-OllamaUp) {
    $v = Invoke-Json "$ollamaUrl/api/version"
    Write-Ok "Ollama $($v.version) is already running (left untouched)."
} elseif ($NoOllama) {
    Write-Warn2 'Ollama is not running and -NoOllama was given. Chat will not work until it is started.'
} else {
    $ollama = Find-Ollama
    if (-not $ollama) {
        Write-Warn2 'Ollama is not installed or not on PATH. Install it from https://ollama.com/download.'
        Write-Info 'The backend will still start; Diagnostics will show the Ollama status.'
    } else {
        $ollamaHost = ([Uri]$ollamaUrl).Authority
        Write-Info "Starting '$ollama serve' (OLLAMA_HOST=$ollamaHost)..."
        $prev = $env:OLLAMA_HOST
        $env:OLLAMA_HOST = $ollamaHost
        $p = Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logDir 'ollama.out.log') -RedirectStandardError (Join-Path $logDir 'ollama.err.log')
        $env:OLLAMA_HOST = $prev
        $up = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-OllamaUp) { $up = $true; break }
            if ($p.HasExited) { break }
        }
        if ($up) {
            Save-Pid 'ollama' $p.Id
            Write-Ok "Ollama started (pid $($p.Id))."
        } else {
            Write-Fail 'Ollama did not become ready within 15 s.'
            Write-Info "See $logDir\ollama.err.log. Another program may be using port $(([Uri]$ollamaUrl).Port)."
        }
    }
}

# 2. Backend ---------------------------------------------------------------
Write-Step "Starting the backend on $backendUrl"
$already = $false
$owner = Get-PortOwner $port
$ourPid = Read-Pid 'backend'
if ($owner) {
    if ($ourPid -and $owner.Id -eq $ourPid -and (Test-BackendUp)) {
        Write-Ok "The backend is already running (pid $ourPid)."
        $owner = $null
        $already = $true
    } elseif (Test-BackendUp) {
        Write-Ok "A Local Browser AI backend is already answering on port $port (pid $($owner.Id), not started by this script)."
        $already = $true
        $owner = $null
    } else {
        Write-Fail "Port $port is already used by '$($owner.ProcessName)' (pid $($owner.Id))."
        Write-Info "Stop that program, or set LBA_PORT=<free port> in backend\.env and update Settings -> Connection -> Backend URL."
        exit 1
    }
}
if (-not $already) {
    $p = Start-Process -FilePath $VenvPython -ArgumentList '-m', 'app.main' -WorkingDirectory $Backend -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDir 'backend.out.log') -RedirectStandardError (Join-Path $logDir 'backend.err.log')
    $up = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-BackendUp) { $up = $true; break }
        if ($p.HasExited) { break }
    }
    if (-not $up) {
        Write-Fail 'The backend did not start.'
        $err = Join-Path $logDir 'backend.err.log'
        if (Test-Path $err) { Get-Content $err -Tail 15 | ForEach-Object { Write-Info $_ } }
        if (-not $p.HasExited) {
            # Also stop the interpreter the venv launcher spawned (it may hold the port).
            Get-CimInstance Win32_Process -Filter "ParentProcessId = $($p.Id)" -ErrorAction SilentlyContinue |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
        Write-Info 'Run scripts\diagnose.ps1 for more details.'
        exit 1
    }
    # A venv python.exe on Windows is a launcher that starts the real interpreter as a child
    # process, so record the process that actually owns the port (plus the launcher).
    $server = Get-PortOwner $port
    $serverPid = $p.Id
    if ($server) { $serverPid = $server.Id }
    Save-Pid 'backend' $serverPid
    if ($serverPid -ne $p.Id) { Save-Pid 'backend-launcher' $p.Id } else { Remove-Pid 'backend-launcher' }
    Write-Ok "Backend started (pid $serverPid)."
}

$h = Invoke-Json "$backendUrl/api/v1/health"
Write-Ok "Health: $($h.status), version $($h.version), API $($h.api_version)"

$origins = Get-EnvFileValue 'LBA_ALLOWED_ORIGINS' ''
if (-not $origins) {
    Write-Warn2 'LBA_ALLOWED_ORIGINS is empty: automatic pairing will not work. Run scripts\build.ps1, then restart.'
}

Write-Host ''
Write-Host 'Services' -ForegroundColor White
Write-Host "  Backend API : $backendUrl/api/v1"
Write-Host "  API docs    : $backendUrl/api/v1/docs"
Write-Host "  Ollama      : $ollamaUrl"
Write-Host "  Logs        : $logDir"
if ($ShowToken) {
    Push-Location $Backend
    $token = (& $VenvPython -m app.cli token).Trim()
    Pop-Location
    Write-Host "  API token   : $token" -ForegroundColor Yellow
    Write-Info 'Paste it in the side panel: Settings -> Connection -> API token (only needed if automatic pairing fails).'
} else {
    Write-Info 'The extension pairs automatically. For manual pairing run: scripts\start.ps1 -ShowToken'
}

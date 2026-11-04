<#
.SYNOPSIS
  Basic environment diagnostics from PowerShell (no model inference).
  For the full report use the Diagnostics page in the side panel.
.PARAMETER Json  Emit machine-readable JSON instead of text.
#>
param([switch]$Json)
. "$PSScriptRoot\common.ps1"
$ErrorActionPreference = 'Continue'

$results = New-Object System.Collections.Generic.List[object]
function Add-Result([string]$name, [string]$status, [string]$message, [string]$fix = '') {
    $results.Add([pscustomobject]@{ check = $name; status = $status; message = $message; fix = $fix })
}

# Python / venv
$py = Find-Python
if ($py) { Add-Result 'Python' 'ok' ((& $py[0] @($py | Select-Object -Skip 1) --version) -join '') }
else { Add-Result 'Python' 'fail' 'Python 3.11+ not found.' 'Install Python 3.12 and run scripts\install.ps1.' }

if (Test-Path $VenvPython) {
    Add-Result 'Backend venv' 'ok' $VenvPython
    Push-Location $Backend
    $check = $null
    try { $check = & $VenvPython -m app.cli check 2>$null | ConvertFrom-Json } catch { }
    Pop-Location
    if ($check) {
        Add-Result 'Data directory' 'ok' $check.data_dir
        if ($check.db_exists) { Add-Result 'Database' 'ok' "schema version $($check.schema_version)" }
        else { Add-Result 'Database' 'fail' 'app.db does not exist.' 'Run scripts\install.ps1 (it initialises the database).' }
        if ($check.token_exists) { Add-Result 'API token' 'ok' 'present' } else { Add-Result 'API token' 'warn' 'not generated yet' 'Run scripts\install.ps1.' }
        if (@($check.allowed_origins).Count) { Add-Result 'Allowed origins' 'ok' (@($check.allowed_origins) -join ', ') }
        else { Add-Result 'Allowed origins' 'warn' 'LBA_ALLOWED_ORIGINS is empty.' 'Run scripts\build.ps1 to write the extension origin, then restart the backend.' }
    } else {
        Add-Result 'Backend imports' 'fail' 'python -m app.cli check failed.' 'Re-run scripts\install.ps1 to reinstall dependencies.'
    }
} else {
    Add-Result 'Backend venv' 'fail' 'backend\.venv missing.' 'Run scripts\install.ps1.'
}

# Disk space
try {
    $drive = (Get-Item (Get-DataDir) -ErrorAction Stop).PSDrive
    $freeGb = [math]::Round($drive.Free / 1GB, 1)
    if ($freeGb -lt 2) { Add-Result 'Disk space' 'warn' "$freeGb GB free on $($drive.Name):" 'Free up space; models and indexes need room.' }
    else { Add-Result 'Disk space' 'ok' "$freeGb GB free on $($drive.Name):" }
} catch { Add-Result 'Disk space' 'warn' 'Could not determine (data dir missing?).' }

# Ollama
$ollama = Find-Ollama
if ($ollama) { Add-Result 'Ollama installed' 'ok' $ollama } else { Add-Result 'Ollama installed' 'fail' 'not found' 'Install from https://ollama.com/download.' }
$ou = Get-OllamaUrl
$v = Invoke-Json "$ou/api/version" 3
if ($v) {
    Add-Result 'Ollama reachable' 'ok' "version $($v.version) at $ou"
    $tags = Invoke-Json "$ou/api/tags" 5
    $names = @($tags.models | ForEach-Object { $_.name })
    if ($names.Count) { Add-Result 'Ollama models' 'ok' ($names -join ', ') }
    else { Add-Result 'Ollama models' 'warn' 'No models installed.' 'ollama pull qwen3:4b-instruct ; ollama pull nomic-embed-text' }
} else {
    Add-Result 'Ollama reachable' 'fail' "Ollama server is not responding at $ou." 'Start Ollama (scripts\start.ps1 does this) and verify the port.'
}

# Backend
$port = Get-BackendPort
$h = Invoke-Json "$(Get-BackendUrl)/api/v1/health" 3
if ($h) { Add-Result 'Backend health' 'ok' "version $($h.version) on port $port" }
else {
    $owner = Get-PortOwner $port
    if ($owner) { Add-Result 'Backend health' 'fail' "Port $port is used by '$($owner.ProcessName)' (pid $($owner.Id)) which is not the backend." 'Free the port or change LBA_PORT.' }
    else { Add-Result 'Backend health' 'warn' "Not running on port $port." 'Run scripts\start.ps1.' }
}

# Extension build
$manifest = Join-Path $Extension '.output\chrome-mv3\manifest.json'
if (Test-Path $manifest) {
    $m = Get-Content $manifest -Raw | ConvertFrom-Json
    Add-Result 'Extension build' 'ok' "version $($m.version) at extension\.output\chrome-mv3"
} else { Add-Result 'Extension build' 'warn' 'Not built.' 'Run scripts\build.ps1.' }
$keyFile = Join-Path $Extension '.extension-key.json'
if (Test-Path $keyFile) {
    $id = (Get-Content $keyFile -Raw | ConvertFrom-Json).id
    $origins = Get-EnvFileValue 'LBA_ALLOWED_ORIGINS' ''
    if ($origins -match [regex]::Escape("chrome-extension://$id")) { Add-Result 'Extension origin' 'ok' "chrome-extension://$id is allow-listed" }
    else { Add-Result 'Extension origin' 'warn' "chrome-extension://$id is not in LBA_ALLOWED_ORIGINS." 'Run scripts\build.ps1 and restart the backend.' }
}

if ($Json) {
    $results | ConvertTo-Json -Depth 3
} else {
    Write-Host "`nLocal Browser AI - environment diagnostics`n" -ForegroundColor White
    foreach ($r in $results) {
        switch ($r.status) {
            'ok' { Write-Ok "$($r.check): $($r.message)" }
            'warn' { Write-Warn2 "$($r.check): $($r.message)" }
            default { Write-Fail "$($r.check): $($r.message)" }
        }
        if ($r.fix) { Write-Info "fix: $($r.fix)" }
    }
    $f = @($results | Where-Object status -eq 'fail').Count
    $w = @($results | Where-Object status -eq 'warn').Count
    Write-Host "`n$($results.Count - $f - $w) ok, $w warning(s), $f failure(s)." -ForegroundColor White
}
if (@($results | Where-Object status -eq 'fail').Count) { exit 1 }
exit 0

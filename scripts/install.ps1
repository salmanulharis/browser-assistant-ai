<#
.SYNOPSIS
  Installs (or upgrades) Local Browser AI: Python venv + backend deps, data directories,
  API token, database migrations, Ollama/model checks, and a production extension build.
.PARAMETER Dev        Also install backend test dependencies (pytest).
.PARAMETER SkipBuild  Do not build the Chrome extension.
.EXAMPLE  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#>
param([switch]$Dev, [switch]$SkipBuild)
. "$PSScriptRoot\common.ps1"

Write-Host "`nLocal Browser AI - install / upgrade`n" -ForegroundColor White

# 1. Python ---------------------------------------------------------------
Write-Step 'Checking Python (3.11+ required)'
$py = Find-Python
if (-not $py) {
    Write-Fail 'Python 3.11 or newer was not found.'
    Write-Info 'Install Python 3.12 from https://www.python.org/downloads/ (tick "Add python.exe to PATH"), then re-run.'
    exit 1
}
$pyExe = $py[0]
$pyArgs = @()
if ($py.Length -gt 1) { $pyArgs = $py[1..($py.Length - 1)] }
$ver = & $pyExe @pyArgs --version
Write-Ok "$ver ($($py -join ' '))"

# 2. Virtual environment ---------------------------------------------------
Write-Step 'Creating / updating the backend virtual environment'
if (Test-Path $VenvPython) {
    Write-Ok 'Existing .venv found - upgrading packages in place.'
} else {
    & $pyExe @pyArgs -m venv (Join-Path $Backend '.venv')
    if ($LASTEXITCODE -ne 0) { Write-Fail 'Could not create the virtual environment.'; exit 1 }
    Write-Ok 'Created backend\.venv'
}
& $VenvPython -m pip install --disable-pip-version-check -q --upgrade pip
$req = if ($Dev) { 'requirements-dev.txt' } else { 'requirements.txt' }
Write-Info "Installing backend\$req (this can take a few minutes the first time)..."
& $VenvPython -m pip install --disable-pip-version-check -q -r (Join-Path $Backend $req)
if ($LASTEXITCODE -ne 0) { Write-Fail 'pip install failed. See the output above.'; exit 1 }
Write-Ok 'Backend dependencies installed.'

# 3. .env ------------------------------------------------------------------
$envFile = Join-Path $Backend '.env'
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $Backend '.env.example') $envFile
    # Leave the placeholder origin out; build.ps1 writes the real one.
    (Get-Content $envFile) | Where-Object { $_ -notmatch '^LBA_ALLOWED_ORIGINS=chrome-extension://<' } | Set-Content $envFile -Encoding utf8
    Write-Ok 'Created backend\.env from .env.example'
} else {
    Write-Ok 'backend\.env exists (kept).'
}

# 4. Data dirs, token, DB ----------------------------------------------------
Write-Step 'Initialising data directory, API token and database'
Push-Location $Backend
try {
    $init = & $VenvPython -m app.cli init | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'app.cli init failed' }
    Write-Ok "Data directory: $($init.data_dir)"
    $applied = @($init.migrations_applied)
    if ($applied.Count) { Write-Ok "Migrations applied: $($applied -join ', ')" } else { Write-Ok "Database schema is up to date." }
} finally { Pop-Location }

# 5. Ollama ----------------------------------------------------------------
Write-Step 'Checking Ollama'
$ollama = Find-Ollama
if (-not $ollama) {
    Write-Warn2 'Ollama is not installed (or not on PATH).'
    Write-Info 'Download it from https://ollama.com/download, then re-run this script or start.ps1.'
} else {
    Write-Ok "Found $ollama"
    if (Test-OllamaUp) {
        $tags = Invoke-Json "$(Get-OllamaUrl)/api/tags" 5
        $names = @($tags.models | ForEach-Object { $_.name })
        Write-Ok "Ollama is running with $($names.Count) model(s)."
        $hasEmbed = $names | Where-Object { $_ -match 'embed|bge|minilm|e5' }
        $hasChat = $names | Where-Object { $_ -notmatch 'embed|bge|minilm|e5' }
        if (-not $hasChat) { Write-Warn2 'No chat model installed. Suggested:  ollama pull qwen3:4b-instruct' }
        if (-not $hasEmbed) { Write-Warn2 'No embedding model installed. Suggested:  ollama pull nomic-embed-text' }
        Write-Info 'Models are never downloaded automatically; pull them yourself or from Settings -> AI.'
    } else {
        Write-Warn2 "Ollama is installed but not running at $(Get-OllamaUrl). start.ps1 will start it."
    }
}

# 6. Extension -------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Step 'Building the Chrome extension'
    & (Join-Path $PSScriptRoot 'build.ps1')
    if ($LASTEXITCODE -ne 0) { Write-Fail 'Extension build failed.'; exit 1 }
}

Write-Host ''
Write-Host 'Installation complete.' -ForegroundColor Green
Write-Host @"

Load the extension in Chrome:
  1. Open chrome://extensions
  2. Enable "Developer mode" (top right)
  3. Click "Load unpacked" and select:
       $Extension\.output\chrome-mv3
  4. Pin "Local Browser AI" and click it to open the side panel.

Then start the services:
  powershell -ExecutionPolicy Bypass -File scripts\start.ps1
"@

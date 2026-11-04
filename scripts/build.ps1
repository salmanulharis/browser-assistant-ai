<#
.SYNOPSIS
  Builds the production Chrome extension and verifies the output. Also pins the
  extension ID and writes the exact origin to backend\.env (LBA_ALLOWED_ORIGINS).
.PARAMETER SkipChecks  Skip the TypeScript type check.
#>
param([switch]$SkipChecks)
. "$PSScriptRoot\common.ps1"

Write-Step 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Fail 'Node.js was not found. Install the LTS version from https://nodejs.org/ and re-run.'
    exit 1
}
$nodeVer = (& node --version).Trim()
$major = [int]($nodeVer.TrimStart('v').Split('.')[0])
if ($major -lt 20) { Write-Fail "Node $nodeVer is too old (20+ required)."; exit 1 }
Write-Ok "Node $nodeVer"

Push-Location $Extension
try {
    if (-not (Test-Path 'node_modules')) {
        Write-Step 'Installing extension dependencies (npm ci)'
        & npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    }

    Write-Step 'Pinning extension ID and syncing the backend CORS origin'
    $extId = (& node scripts/extension-key.mjs --sync).Trim()
    if ($LASTEXITCODE -ne 0 -or $extId -notmatch '^[a-p]{32}$') { throw "Could not determine the extension ID ($extId)" }
    Write-Ok "Extension ID: $extId"
    Write-Ok "backend\.env allows chrome-extension://$extId"

    if (-not $SkipChecks) {
        Write-Step 'Type checking'
        & npx wxt prepare | Out-Null
        & npx tsc --noEmit
        if ($LASTEXITCODE -ne 0) { throw 'TypeScript errors (see above)' }
        Write-Ok 'No type errors.'
    }

    Write-Step 'Building (wxt build)'
    & npx wxt build
    if ($LASTEXITCODE -ne 0) { throw 'wxt build failed' }

    Write-Step 'Verifying build output'
    $out = Join-Path $Extension '.output\chrome-mv3'
    $required = @('manifest.json', 'background.js', 'sidepanel.html', 'options.html', 'page-agent.js', 'content-scripts\floating.js')
    $missing = @($required | Where-Object { -not (Test-Path (Join-Path $out $_)) })
    if ($missing.Count) { throw "Missing build files: $($missing -join ', ')" }
    $manifest = Get-Content (Join-Path $out 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.manifest_version -ne 3) { throw 'manifest_version is not 3' }
    if ($manifest.host_permissions -contains '<all_urls>') { throw 'Unexpected <all_urls> host permission' }
    Write-Ok "Manifest V3, version $($manifest.version), all required files present."
    Write-Info "Load unpacked from: $out"
    Write-Info 'If the backend is running, restart it (stop.ps1 + start.ps1) so it picks up the allowed origin.'
} catch {
    Write-Fail $_
    exit 1
} finally {
    Pop-Location
}
exit 0

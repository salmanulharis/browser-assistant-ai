<#
.SYNOPSIS
  Creates a backup (database + vectors + uploaded documents) or restores one.
.PARAMETER Restore  Path to a backup zip to restore. The backend must be stopped;
                    the current data is saved as a safety backup first.
.PARAMETER List     List existing backups.
#>
param([string]$Restore, [switch]$List)
. "$PSScriptRoot\common.ps1"
Assert-Venv

$backups = Join-Path (Get-DataDir) 'backups'
Push-Location $Backend
try {
    if ($List) {
        Get-ChildItem $backups -Filter '*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending |
            Format-Table Name, @{ n = 'Size (MB)'; e = { [math]::Round($_.Length / 1MB, 1) } }, LastWriteTime -AutoSize
        return
    }
    if ($Restore) {
        if (-not (Test-Path $Restore)) { Write-Fail "Backup not found: $Restore"; exit 1 }
        if (Test-BackendUp) {
            Write-Fail 'The backend is running. Stop it first (scripts\stop.ps1) so files are not in use.'
            exit 1
        }
        Write-Step "Restoring $Restore"
        $res = & $VenvPython -m app.cli restore (Resolve-Path $Restore).Path | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { Write-Fail 'Restore failed.'; exit 1 }
        Write-Ok 'Restore complete.'
        Write-Info "Previous data saved as: $($res.safety_backup)"
        Write-Info 'Start the backend again with scripts\start.ps1.'
        return
    }
    Write-Step 'Creating backup'
    $path = (& $VenvPython -m app.cli backup).Trim()
    if ($LASTEXITCODE -ne 0) { Write-Fail 'Backup failed.'; exit 1 }
    Write-Ok "Backup written: $path"
} finally {
    Pop-Location
}

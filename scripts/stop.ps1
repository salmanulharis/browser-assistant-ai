<#
.SYNOPSIS
  Stops ONLY the processes started by start.ps1 (recorded in <data>\run\*.pid).
  Unrelated Python or Ollama processes are never touched. User data is preserved.
.PARAMETER KeepOllama  Leave Ollama running even if start.ps1 started it.
#>
param([switch]$KeepOllama)
. "$PSScriptRoot\common.ps1"

function Stop-Owned([string]$name, [string]$mustMatch) {
    $procId = Read-Pid $name
    if (-not $procId) { Write-Info "No $name process recorded by start.ps1."; return }
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Info "$name (pid $procId) is no longer running."
        Remove-Pid $name
        return
    }
    $cmd = Get-CommandLine $procId
    if ($cmd -and $cmd -notmatch $mustMatch) {
        # PID was reused by an unrelated program - do not kill it.
        Write-Warn2 "pid $procId now belongs to another program ('$($proc.ProcessName)'); not stopping it."
        Remove-Pid $name
        return
    }
    Stop-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc.WaitForExit(5000)) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
    Remove-Pid $name
    Write-Ok "Stopped $name (pid $procId)."
}

Write-Step 'Stopping Local Browser AI'
Stop-Owned 'backend' 'app\.main'
# The venv launcher normally exits with its child; stop it too if it is still around.
if (Read-Pid 'backend-launcher') { Stop-Owned 'backend-launcher' 'app\.main' }
if ($KeepOllama) {
    Write-Info 'Leaving Ollama running (-KeepOllama).'
} else {
    Stop-Owned 'ollama' 'ollama'
}
Write-Ok 'Done. Your data was not modified.'

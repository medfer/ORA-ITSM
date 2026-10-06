<#
.SYNOPSIS
  Run every 5 minutes by the ORA-ITSM-Watchdog scheduled task: makes sure ORA ITSM and Caddy are running
  and that the application answers; restarts what is down. Actions are written to logs\watchdog.log.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$log = 'watchdog.log'

try {
  $app = Get-ScheduledTask -TaskName $OraTasks.App -ErrorAction SilentlyContinue
  if (-not $app) { Write-OraLog $log "Task $($OraTasks.App) not found - nothing to watch"; exit 0 }

  if ($app.State -eq 'Disabled') {
    exit 0   # stopped on purpose by an administrator (tasks.ps1 -Action Stop)
  } elseif ($app.State -ne 'Running') {
    Write-OraLog $log "Task $($OraTasks.App) was '$($app.State)' - starting it"
    if (Start-OraApp) { Write-OraLog $log 'ORA ITSM is back online' } else { Write-OraLog $log 'ORA ITSM still not answering' }
  } else {
    # Running: check that it answers (3 tries, 10 s apart); ignore the first 2 minutes after a start
    $healthy = $false
    for ($i = 0; $i -lt 3 -and -not $healthy; $i++) {
      if ($i) { Start-Sleep -Seconds 10 }
      $healthy = Test-OraHealth 10
    }
    $lastRun = (Get-ScheduledTaskInfo -TaskName $OraTasks.App).LastRunTime
    if (-not $healthy -and $lastRun -lt (Get-Date).AddMinutes(-2)) {
      Write-OraLog $log 'ORA ITSM is not answering on /api/health - restarting it'
      Stop-OraApp
      if (Start-OraApp) { Write-OraLog $log 'ORA ITSM is back online' } else { Write-OraLog $log 'ORA ITSM still not answering after restart' }
    }
  }

  $caddy = Get-ScheduledTask -TaskName $OraTasks.Caddy -ErrorAction SilentlyContinue
  if ($caddy -and $caddy.State -eq 'Ready') {
    Write-OraLog $log "Task $($OraTasks.Caddy) was not running - starting it"
    Start-ScheduledTask -TaskName $OraTasks.Caddy
  }
} catch {
  Write-OraLog $log "Watchdog error: $($_.Exception.Message)"
  exit 1
}

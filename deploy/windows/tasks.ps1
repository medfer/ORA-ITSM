<#
.SYNOPSIS
  Creates and manages the ORA ITSM scheduled tasks (automatic start with Windows, watchdog, daily backup).

.DESCRIPTION
  Tasks created (all run as SYSTEM, whether or not someone is signed in):
    ORA-ITSM           at startup  - supervisor (run-app.ps1): runs Node.js, logs to logs\, restarts it if it crashes
    ORA-ITSM-Caddy     at startup  - HTTPS reverse proxy (only if C:\caddy\caddy.exe and Caddyfile exist)
    ORA-ITSM-Watchdog  every 5 min - restarts the application / Caddy if they are down or not answering
    ORA-ITSM-Backup    daily       - hot backup of the database and attachments

.EXAMPLE
  # Create (or re-create) all tasks and start the application
  powershell -ExecutionPolicy Bypass -File C:\ora-itsm\deploy\windows\tasks.ps1 -Action Install

  # Backup every day at 01:30 on another disk, keep 60 backups
  powershell -ExecutionPolicy Bypass -File C:\ora-itsm\deploy\windows\tasks.ps1 -Action Install -BackupDir D:\Backups\ora-itsm -BackupTime 01:30 -KeepBackups 60

  # Status, restart, stop (stays stopped, even after a reboot), start, remove
  ... tasks.ps1 -Action Status | Restart | Stop | Start | Remove

.NOTES
  Run in PowerShell opened with "Run as administrator".
#>
param(
  [ValidateSet('Install', 'Status', 'Start', 'Stop', 'Restart', 'Remove')]
  [string]$Action = 'Status',
  [string]$CaddyDir = 'C:\caddy',
  [string]$BackupDir,
  [ValidatePattern('^\d{1,2}:\d{2}$')][string]$BackupTime = '02:00',
  [ValidateRange(1, 3650)][int]$KeepBackups = 30,
  [switch]$NoWatchdog,
  [switch]$NoBackup
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Admin

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }

function Register-OraTask {
  param([string]$Name, [string]$Description, [string]$Execute, [string]$Arguments, [string]$WorkDir,
        $Trigger, [TimeSpan]$TimeLimit = [TimeSpan]::Zero, [switch]$RestartOnFailure)
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
  $action = New-ScheduledTaskAction -Execute $Execute -Argument $Arguments -WorkingDirectory $WorkDir
  $opts = @{
    ExecutionTimeLimit = $TimeLimit; MultipleInstances = 'IgnoreNew'; StartWhenAvailable = $true
    AllowStartIfOnBatteries = $true; DontStopIfGoingOnBatteries = $true
  }
  if ($RestartOnFailure) { $opts.RestartCount = 999; $opts.RestartInterval = New-TimeSpan -Minutes 1 }
  $settings = New-ScheduledTaskSettingsSet @opts
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $Name -Description $Description -Action $action -Trigger $Trigger `
    -Settings $settings -Principal $principal | Out-Null
  Write-Host "  Task $Name created"
}

function New-StartupTrigger {
  $t = New-ScheduledTaskTrigger -AtStartup
  $t.Delay = 'PT30S'   # let the network start first
  return $t
}

function New-RepeatTrigger([int]$Minutes) {
  $at = (Get-Date).Date.AddMinutes([Math]::Ceiling(((Get-Date) - (Get-Date).Date).TotalMinutes) + 1)
  try {
    return New-ScheduledTaskTrigger -Once -At $at -RepetitionInterval (New-TimeSpan -Minutes $Minutes)
  } catch {
    # Older Windows versions require a duration
    return New-ScheduledTaskTrigger -Once -At $at -RepetitionInterval (New-TimeSpan -Minutes $Minutes) `
      -RepetitionDuration (New-TimeSpan -Days 3650)
  }
}

function Show-Status {
  $rows = foreach ($name in $OraTasks.Values) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) { [pscustomobject]@{ Task = $name; State = 'not installed'; 'Last run' = ''; 'Last result' = ''; 'Next run' = '' }; continue }
    $info = Get-ScheduledTaskInfo -TaskName $name
    [pscustomobject]@{
      Task          = $name
      State         = $task.State
      'Last run'    = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString('yyyy-MM-dd HH:mm') } else { '' }
      'Last result' = if ($task.State -eq 'Running') { 'running' } else { '0x{0:X}' -f $info.LastTaskResult }
      'Next run'    = if ($info.NextRunTime) { $info.NextRunTime.ToString('yyyy-MM-dd HH:mm') } else { '' }
    }
  }
  $rows | Format-Table -AutoSize | Out-String | Write-Host
  $port = Get-OraPort
  if (Test-OraHealth) { Write-Host "Application: ONLINE (http://127.0.0.1:$port/api/health)" -ForegroundColor Green }
  else { Write-Host "Application: NOT ANSWERING on http://127.0.0.1:$port" -ForegroundColor Red }
  $nodes = @(Get-OraNodeProcess)
  if ($nodes.Count) { Write-Host "node.exe PID: $(($nodes | ForEach-Object ProcessId) -join ', ')" }
  Write-Host "Logs: $OraLogDir"
}

$appTask = $OraTasks.App
switch ($Action) {

  'Install' {
    $node = Get-OraNode
    $version = (& $node -v).TrimStart('v')
    if ([int]$version.Split('.')[0] -lt 22) { throw "Node.js $version found; version 22 or later is required." }
    Write-Host "Application folder: $OraAppDir"
    Write-Host "Node.js $version ($node)"
    if (-not (Test-Path (Join-Path $OraAppDir 'node_modules\express'))) {
      throw "Dependencies are missing: run 'npm install --omit=dev' in $OraAppDir first (or use install.ps1)."
    }
    New-Item -ItemType Directory -Force -Path $OraLogDir | Out-Null
    $ps = Get-PowerShellExe

    Step 'Stopping previous instances (if any)'
    Stop-OraApp

    Step 'Creating the scheduled tasks'
    Register-OraTask -Name $appTask -Description 'ORA ITSM application (Node.js) - starts with Windows, restarted if it stops' `
      -Execute $ps -Arguments (Get-ScriptArgs 'run-app.ps1') -WorkDir $OraAppDir -Trigger (New-StartupTrigger) -RestartOnFailure

    $caddyExe = Join-Path $CaddyDir 'caddy.exe'
    $caddyfile = Join-Path $CaddyDir 'Caddyfile'
    if ((Test-Path $caddyExe) -and (Test-Path $caddyfile)) {
      if (Get-ScheduledTask -TaskName $OraTasks.Caddy -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $OraTasks.Caddy }
      Register-OraTask -Name $OraTasks.Caddy -Description 'Caddy HTTPS reverse proxy for ORA ITSM' `
        -Execute $caddyExe -Arguments "run --config `"$caddyfile`"" -WorkDir $CaddyDir -Trigger (New-StartupTrigger) -RestartOnFailure
    } else {
      Write-Host "  Caddy not found in $CaddyDir - HTTPS task skipped (install.ps1 sets it up)" -ForegroundColor Yellow
    }

    if ($NoWatchdog) { Unregister-ScheduledTask -TaskName $OraTasks.Watchdog -Confirm:$false -ErrorAction SilentlyContinue }
    else {
      Register-OraTask -Name $OraTasks.Watchdog -Description 'Restarts ORA ITSM / Caddy if they are down (every 5 minutes)' `
        -Execute $ps -Arguments (Get-ScriptArgs 'watchdog.ps1') -WorkDir $OraAppDir -Trigger (New-RepeatTrigger 5) `
        -TimeLimit (New-TimeSpan -Minutes 10)
    }

    if ($NoBackup) { Unregister-ScheduledTask -TaskName $OraTasks.Backup -Confirm:$false -ErrorAction SilentlyContinue }
    else {
      if (-not $BackupDir) { $BackupDir = Join-Path $OraAppDir 'backups' }
      New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
      Register-OraTask -Name $OraTasks.Backup -Description "Daily ORA ITSM backup to $BackupDir (keeps $KeepBackups)" `
        -Execute $ps -Arguments (Get-ScriptArgs 'backup.ps1' "-Destination `"$BackupDir`" -Keep $KeepBackups") -WorkDir $OraAppDir `
        -Trigger (New-ScheduledTaskTrigger -Daily -At $BackupTime) -TimeLimit (New-TimeSpan -Hours 2)
      Write-Host "  Backups: every day at $BackupTime to $BackupDir (last $KeepBackups kept)"
    }

    Step 'Starting ORA ITSM'
    if (-not (Start-OraApp)) {
      Show-Status
      throw "ORA ITSM did not answer within 45 s. Look at the newest files in $OraLogDir"
    }
    if (Get-ScheduledTask -TaskName $OraTasks.Caddy -ErrorAction SilentlyContinue) { Start-ScheduledTask -TaskName $OraTasks.Caddy }
    Show-Status
    Write-Host "`nDONE: ORA ITSM now starts automatically with Windows." -ForegroundColor Green
  }

  'Start' {
    foreach ($name in $appTask, $OraTasks.Caddy) {
      if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Enable-ScheduledTask -TaskName $name | Out-Null }
    }
    $ok = Start-OraApp
    if (Get-ScheduledTask -TaskName $OraTasks.Caddy -ErrorAction SilentlyContinue) { Start-ScheduledTask -TaskName $OraTasks.Caddy }
    Show-Status
    if (-not $ok) { throw "ORA ITSM did not answer within 45 s. Look at the newest files in $OraLogDir" }
  }

  'Restart' {
    Stop-OraApp
    $ok = Start-OraApp
    Show-Status
    if (-not $ok) { throw "ORA ITSM did not answer within 45 s. Look at the newest files in $OraLogDir" }
  }

  'Stop' {
    # Disabled so that neither the watchdog nor a reboot starts it again; use -Action Start to undo
    Stop-OraApp
    Disable-ScheduledTask -TaskName $appTask | Out-Null
    Write-Host 'ORA ITSM stopped and disabled (Caddy keeps running). Start again with: tasks.ps1 -Action Start' -ForegroundColor Yellow
    Show-Status
  }

  'Remove' {
    Stop-OraApp
    foreach ($name in $OraTasks.Values) {
      if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "  Task $name removed"
      }
    }
    Write-Host 'All ORA ITSM tasks removed. Data, logs and backups are kept.' -ForegroundColor Yellow
  }

  'Status' { Show-Status }
}

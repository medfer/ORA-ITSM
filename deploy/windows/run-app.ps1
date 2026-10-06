<#
.SYNOPSIS
  Supervisor started by the ORA-ITSM scheduled task: runs node server\index.js, writes its output to logs\,
  and restarts it automatically if it stops or crashes. Not meant to be run by hand (use tasks.ps1).
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$node = Get-OraNode
$log = 'supervisor.log'
$keepDays = 30
$failures = 0

# A node.exe left over from a previous supervisor would keep the port busy
foreach ($p in Get-OraNodeProcess) {
  Write-OraLog $log "Stopping leftover node.exe (PID $($p.ProcessId))"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

while ($true) {
  Get-ChildItem $OraLogDir -Filter 'app-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$keepDays) } | Remove-Item -Force -ErrorAction SilentlyContinue

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $out = Join-Path $OraLogDir "app-$stamp.log"
  $err = Join-Path $OraLogDir "app-$stamp.err.log"
  Write-OraLog $log "Starting ORA ITSM: $node (output: app-$stamp.log)"

  $started = Get-Date
  $proc = Start-Process -FilePath $node -WorkingDirectory $OraAppDir -NoNewWindow -PassThru `
    -ArgumentList "--env-file-if-exists=.env --disable-warning=ExperimentalWarning `"$OraServerScript`"" `
    -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $proc.Handle   # keeps the handle so ExitCode is available after exit
  $proc.WaitForExit()

  $ran = (Get-Date) - $started
  Write-OraLog $log ("ORA ITSM stopped (exit code {0}) after {1:N0} s" -f $proc.ExitCode, $ran.TotalSeconds)
  if ((Test-Path $err) -and (Get-Item $err).Length -eq 0) { Remove-Item $err -Force -ErrorAction SilentlyContinue }

  # Quick crash loop -> wait longer between attempts (5 s ... 5 min)
  if ($ran.TotalMinutes -lt 2) { $failures++ } else { $failures = 0 }
  $delay = [Math]::Min(300, 5 * [Math]::Pow(2, [Math]::Min($failures, 6)))
  Write-OraLog $log "Restarting in $delay s"
  Start-Sleep -Seconds $delay
}

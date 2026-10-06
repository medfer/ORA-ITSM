<#
.SYNOPSIS
  Hot backup of ORA ITSM (database + attachments), safe while the application is running.
  Run daily by the ORA-ITSM-Backup scheduled task; can also be run by hand. Result in logs\backup.log.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\ora-itsm\deploy\windows\backup.ps1 -Destination D:\Backups\ora-itsm -Keep 30
#>
param(
  [string]$Destination,
  [int]$Keep = 30
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Destination) { $Destination = Join-Path $OraAppDir 'backups' }
$log = 'backup.log'

$node = Get-OraNode
Push-Location $OraAppDir
try {
  $ErrorActionPreference = 'Continue'   # node writes errors to stderr; do not turn them into exceptions
  $output = & $node --env-file-if-exists=.env --disable-warning=ExperimentalWarning server\backup.js $Destination --keep $Keep 2>&1
  $code = $LASTEXITCODE
} finally { Pop-Location }

foreach ($line in $output) { Write-OraLog $log "$line"; Write-Host $line }
if ($code -ne 0) { Write-OraLog $log "Backup failed (exit code $code)"; exit $code }

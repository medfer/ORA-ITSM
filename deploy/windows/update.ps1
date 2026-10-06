<#
.SYNOPSIS
  Updates ORA ITSM on Windows Server: backs up the database, downloads the latest code (git),
  installs dependencies and restarts. Data (the data folder) is kept. Run in PowerShell "Run as administrator".

.PARAMETER RefreshTasks
  Also re-creates the scheduled tasks (tasks.ps1 -Action Install, default options) after updating.
#>
param([switch]$RefreshTasks)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Admin
Set-Location $OraAppDir
$node = Get-OraNode

Write-Host '==> Backing up the database' -ForegroundColor Cyan
& $node --env-file-if-exists=.env --disable-warning=ExperimentalWarning server\backup.js backups --prefix pre-update --keep 10 --db-only
if ($LASTEXITCODE -ne 0) { throw 'Backup failed - update cancelled' }

Write-Host '==> Stopping ORA ITSM' -ForegroundColor Cyan
Stop-OraApp

try {
  Write-Host '==> Downloading the latest version' -ForegroundColor Cyan
  & git.exe pull
  if ($LASTEXITCODE -ne 0) { throw 'git pull failed' }
  & npm.cmd install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
} finally {
  if (-not $RefreshTasks) {
    Write-Host '==> Starting ORA ITSM' -ForegroundColor Cyan
    if (Start-OraApp) { Write-Host 'ORA ITSM is online.' -ForegroundColor Green }
    else { Write-Host "ORA ITSM is not answering yet - check the newest files in $OraLogDir" -ForegroundColor Red }
  }
}

# The scripts may have changed with the update: run tasks.ps1 in a new PowerShell process
if ($RefreshTasks) { & (Get-PowerShellExe) -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'tasks.ps1') -Action Install }
Write-Host 'Updated.' -ForegroundColor Green

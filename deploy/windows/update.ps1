<#
.SYNOPSIS
  Updates ORA ITSM on Windows Server: downloads the latest code (git), installs dependencies and restarts.
  Data (the data folder) is kept. Run in PowerShell "Run as administrator".
#>
$ErrorActionPreference = 'Stop'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $AppDir

Write-Host '==> Stopping ORA ITSM' -ForegroundColor Cyan
Stop-ScheduledTask -TaskName 'ORA-ITSM'
Start-Sleep -Seconds 2

Write-Host '==> Backing up the database' -ForegroundColor Cyan
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'backups') | Out-Null
Copy-Item (Join-Path $AppDir 'data\ora-itsm.db') (Join-Path $AppDir "backups\ora-itsm-$stamp.db") -ErrorAction SilentlyContinue

Write-Host '==> Downloading the latest version' -ForegroundColor Cyan
& git.exe pull
if ($LASTEXITCODE -ne 0) { throw 'git pull failed' }
& npm.cmd install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

Write-Host '==> Starting ORA ITSM' -ForegroundColor Cyan
Start-ScheduledTask -TaskName 'ORA-ITSM'
Write-Host 'Updated.' -ForegroundColor Green

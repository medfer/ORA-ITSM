<#
.SYNOPSIS
  Installs ORA ITSM on Windows Server, published over HTTPS with Caddy (free Let's Encrypt certificate).
  The application and Caddy start automatically with Windows (scheduled tasks running as SYSTEM, see tasks.ps1),
  a watchdog restarts them if they stop, and a daily backup is scheduled.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\ora-itsm\deploy\windows\install.ps1 -Domain ora-itsm.duckdns.org -Email you@example.com

.EXAMPLE
  # Backups on another disk every day at 01:30, keep 60
  powershell -ExecutionPolicy Bypass -File C:\ora-itsm\deploy\windows\install.ps1 -Domain itsm.example.com -Email you@example.com -BackupDir D:\Backups\ora-itsm -BackupTime 01:30 -KeepBackups 60

.NOTES
  Run in PowerShell opened with "Run as administrator". Requires Node.js 22 LTS or later.
  Ports 80 and 443 must be reachable from the Internet (Azure: add an inbound rule on the VM network security group).
#>
param(
  [Parameter(Mandatory = $true)][string]$Domain,
  [Parameter(Mandatory = $true)][string]$Email,
  [string]$CaddyDir = 'C:\caddy',
  [string]$BackupDir,
  [string]$BackupTime = '02:00',
  [int]$KeepBackups = 30
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # much faster downloads in Windows PowerShell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot 'common.ps1')
$Port = Get-OraPort

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }

Assert-Admin
$AppDir = $OraAppDir
Write-Host "Application folder: $AppDir"

Step 'Checking Node.js'
$node = Get-OraNode
$version = (& $node -v).TrimStart('v')
if ([int]$version.Split('.')[0] -lt 22) { throw "Node.js $version found; version 22 or later is required." }
Write-Host "Node.js $version ($node)"

Step 'Stopping previous instances (if any)'
if (Get-ScheduledTask -TaskName $OraTasks.Caddy -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $OraTasks.Caddy }
Stop-OraApp

Step 'Installing application dependencies'
Push-Location $AppDir
try {
  Invoke-Native 'npm.cmd' @('install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error') 'npm install failed'
} finally { Pop-Location }

Step 'Downloading Caddy (web server with automatic HTTPS)'
New-Item -ItemType Directory -Force -Path $CaddyDir, (Join-Path $CaddyDir 'data') | Out-Null
$caddy = Join-Path $CaddyDir 'caddy.exe'

# A valid Windows executable starts with "MZ" and Caddy is larger than 10 MB
function Test-Executable([string]$Path) {
  if (-not (Test-Path $Path)) { return $false }
  if ((Get-Item $Path).Length -lt 10MB) { return $false }
  $stream = [IO.File]::OpenRead($Path)
  try { return ($stream.ReadByte() -eq 0x4D -and $stream.ReadByte() -eq 0x5A) } finally { $stream.Close() }
}

if (-not (Test-Executable $caddy)) {
  if (Test-Path $caddy) { Write-Host 'Removing an invalid caddy.exe from a previous attempt'; Remove-Item $caddy -Force }
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $caddyArch = if ($arch -eq 'ARM64') { 'arm64' } else { 'amd64' }
  Write-Host "Processor architecture: $arch -> Caddy windows_$caddyArch"
  $url = $null
  try {
    $release = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/caddyserver/caddy/releases/latest'
    $url = ($release.assets | Where-Object { $_.name -like "caddy_*_windows_$caddyArch.zip" } | Select-Object -First 1).browser_download_url
  } catch { Write-Host 'GitHub API unavailable, using a known Caddy version' }
  if (-not $url) { $url = "https://github.com/caddyserver/caddy/releases/download/v2.10.2/caddy_2.10.2_windows_$caddyArch.zip" }
  Write-Host "Downloading $url"
  $zip = Join-Path $env:TEMP 'caddy-download.zip'
  $extract = Join-Path $env:TEMP 'caddy-download'
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  Copy-Item (Join-Path $extract 'caddy.exe') $caddy -Force
  Remove-Item $zip, $extract -Recurse -Force -ErrorAction SilentlyContinue
  if (-not (Test-Executable $caddy)) {
    throw "Caddy download failed. Download the Windows zip manually from https://github.com/caddyserver/caddy/releases, put caddy.exe in $CaddyDir and run this script again."
  }
}
& $caddy version
if ($LASTEXITCODE -ne 0) { throw 'caddy.exe cannot run on this server' }

Step "Writing Caddy configuration for https://$Domain"
$caddyPath = $CaddyDir -replace '\\', '/'
$caddyfile = @"
{
	email $Email
	storage file_system {
		root $caddyPath/data
	}
	log {
		output file $caddyPath/caddy.log
	}
}

$Domain {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}
	request_body {
		max_size 25MB
	}
	reverse_proxy 127.0.0.1:$Port
}
"@
$caddyfilePath = Join-Path $CaddyDir 'Caddyfile'
Set-Content -Path $caddyfilePath -Value $caddyfile -Encoding ASCII
& $caddy validate --config $caddyfilePath --adapter caddyfile
if ($LASTEXITCODE -ne 0) { throw 'The generated Caddyfile is invalid' }

Step 'Opening Windows Firewall ports 80 and 443'
if (-not (Get-NetFirewallRule -DisplayName 'ORA ITSM HTTP/HTTPS' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'ORA ITSM HTTP/HTTPS' -Direction Inbound -Protocol TCP -LocalPort 80, 443 -Action Allow | Out-Null
}

Step 'Creating the scheduled tasks (auto-start with Windows, watchdog, daily backup)'
$taskArgs = @{ Action = 'Install'; CaddyDir = $CaddyDir; BackupTime = $BackupTime; KeepBackups = $KeepBackups }
if ($BackupDir) { $taskArgs.BackupDir = $BackupDir }
& (Join-Path $PSScriptRoot 'tasks.ps1') @taskArgs

Step "Checking https://$Domain (Caddy requests the SSL certificate on first start)"
$ok = $false
for ($i = 0; $i -lt 24 -and -not $ok; $i++) {
  Start-Sleep -Seconds 5
  try { $ok = (Invoke-WebRequest -UseBasicParsing "https://$Domain/api/health" -TimeoutSec 5).StatusCode -eq 200 } catch { }
}

if ($ok) {
  Write-Host "`nDONE: ORA ITSM is online at https://$Domain" -ForegroundColor Green
  Write-Host 'Sign in, change the admin password, then create the user accounts.'
} else {
  Write-Host "`nHTTPS is not reachable yet at https://$Domain" -ForegroundColor Yellow
  Write-Host 'Check:'
  Write-Host "  1. DNS: nslookup $Domain must return this server's public IP"
  Write-Host '  2. Azure portal > VM > Networking: inbound rule allowing TCP 80 and 443'
  Write-Host "  3. Caddy log: Get-Content $caddyPath/caddy.log -Tail 30"
  Write-Host 'Caddy keeps retrying automatically; re-open the address in a few minutes.'
}

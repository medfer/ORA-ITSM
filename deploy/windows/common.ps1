# Shared helpers for the ORA ITSM Windows scripts (dot-sourced: . "$PSScriptRoot\common.ps1")
# Compatible with Windows PowerShell 5.1.

$OraAppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$OraServerScript = Join-Path $OraAppDir 'server\index.js'
$OraLogDir = Join-Path $OraAppDir 'logs'

$OraTasks = [ordered]@{
  App      = 'ORA-ITSM'
  Caddy    = 'ORA-ITSM-Caddy'
  Watchdog = 'ORA-ITSM-Watchdog'
  Backup   = 'ORA-ITSM-Backup'
}

function Assert-Admin {
  $identity = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Please run this script in PowerShell opened with "Run as administrator".'
  }
}

# Values from the .env file of the application (KEY=value, # comments, optional quotes)
function Get-OraEnv([string]$Name, [string]$Default) {
  $file = Join-Path $OraAppDir '.env'
  if (Test-Path $file) {
    foreach ($line in Get-Content $file) {
      if ($line -match "^\s*$Name\s*=\s*(.*?)\s*$") { return $Matches[1].Trim('"', "'") }
    }
  }
  return $Default
}

function Get-OraPort { [int](Get-OraEnv 'PORT' '8080') }

function Get-OraNode {
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node -and (Test-Path "$env:ProgramFiles\nodejs\node.exe")) { $node = "$env:ProgramFiles\nodejs\node.exe" }
  if (-not $node) { throw 'Node.js is not installed. Install Node.js 22 LTS from https://nodejs.org' }
  return $node
}

function Write-OraLog([string]$File, [string]$Message) {
  New-Item -ItemType Directory -Force -Path $OraLogDir | Out-Null
  $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message
  Add-Content -Path (Join-Path $OraLogDir $File) -Value $line -Encoding UTF8
}

function Test-OraHealth([int]$TimeoutSec = 5) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$(Get-OraPort)/api/health" -TimeoutSec $TimeoutSec
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Wait-OraHealth([int]$Seconds = 45) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-OraHealth 2) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# node.exe processes running THIS installation (matched on the absolute path of server\index.js)
function Get-OraNodeProcess {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($OraServerScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
}

# Stops the supervisor task AND its node.exe (Task Scheduler does not always end child processes)
function Stop-OraApp {
  if (Get-ScheduledTask -TaskName $OraTasks.App -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $OraTasks.App -ErrorAction SilentlyContinue
  }
  foreach ($p in Get-OraNodeProcess) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

function Start-OraApp {
  Start-ScheduledTask -TaskName $OraTasks.App
  return (Wait-OraHealth 45)
}

function Get-PowerShellExe { Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }

# Argument string to run one of the scripts of this folder hidden
function Get-ScriptArgs([string]$Script, [string]$Extra = '') {
  $path = Join-Path $PSScriptRoot $Script
  "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$path`" $Extra".Trim()
}

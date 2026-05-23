# PumpDirect — Windows update helper
# Run from an admin PowerShell:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\update.ps1
# Stops the PumpDirect Windows Service (if installed and running), pulls from
# origin/main, runs npm install if package-lock.json changed, restarts the
# service. Probes common git install locations so PATH issues don't bite —
# GitHub Desktop ships a bundled git that's not on PATH; this script finds it.

$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $proj

Write-Host ""
Write-Host "========================================"
Write-Host "  PumpDirect updater"
Write-Host "========================================"
Write-Host ""

function Find-Git {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "$env:ProgramFiles\Git\cmd\git.exe",
    "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
    "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
  )
  $ghd = Get-ChildItem -Path "$env:LOCALAPPDATA\GitHubDesktop\app-*\resources\app\git\cmd\git.exe" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if ($ghd) { $candidates += $ghd.FullName }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

function Find-Npm {
  $cmd = Get-Command npm -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "$env:ProgramFiles\nodejs\npm.cmd",
    "${env:ProgramFiles(x86)}\nodejs\npm.cmd"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

$git = Find-Git
if (-not $git) {
  Write-Host "ERROR: git not found." -ForegroundColor Red
  Write-Host "Install Git for Windows from https://git-scm.com/download/win and re-run."
  Write-Host ""
  Read-Host "Press Enter to close"
  exit 1
}
Write-Host "Using git: $git"

$npm = Find-Npm
if (-not $npm) {
  Write-Host "ERROR: npm not found." -ForegroundColor Red
  Write-Host "Install Node.js LTS from https://nodejs.org and re-run."
  Write-Host ""
  Read-Host "Press Enter to close"
  exit 1
}
Write-Host "Using npm: $npm"
Write-Host ""

# Stop the service if installed and running. Remember the state so we can
# put it back the way we found it.
$svcWasRunning = $false
$svc = Get-Service -Name PumpDirect -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
  Write-Host "Stopping PumpDirect service..."
  try {
    Stop-Service -Name PumpDirect -ErrorAction Stop
    $svcWasRunning = $true
  } catch {
    Write-Host "ERROR: failed to stop service. Open PowerShell as Administrator and re-run." -ForegroundColor Red
    Write-Host $_.Exception.Message
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
  }
}

Write-Host "Pulling latest from origin/main..."
$lockBefore = if (Test-Path "package-lock.json") { (Get-FileHash package-lock.json).Hash } else { $null }
& $git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "ERROR: git pull failed (likely diverged history or local edits)." -ForegroundColor Red
  Write-Host "To force the local tree to match origin/main: git reset --hard origin/main"
  if ($svcWasRunning) { Start-Service -Name PumpDirect }
  Write-Host ""
  Read-Host "Press Enter to close"
  exit 1
}
$lockAfter = if (Test-Path "package-lock.json") { (Get-FileHash package-lock.json).Hash } else { $null }

if ($lockBefore -ne $lockAfter -or -not (Test-Path "node_modules")) {
  Write-Host "Dependencies changed - running npm install..."
  & $npm install --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: npm install failed." -ForegroundColor Red
    if ($svcWasRunning) { Start-Service -Name PumpDirect }
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
  }
} else {
  Write-Host "Dependencies unchanged - skipping npm install."
}

if ($svcWasRunning) {
  Write-Host "Starting PumpDirect service..."
  Start-Service -Name PumpDirect
  Start-Sleep -Seconds 2
  $svc = Get-Service -Name PumpDirect
  if ($svc.Status -eq "Running") {
    Write-Host ""
    Write-Host "Update complete. Service is running." -ForegroundColor Green
  } else {
    Write-Host ""
    Write-Host "WARNING: service did not return to Running (status: $($svc.Status))" -ForegroundColor Yellow
    Write-Host "Check logs: Get-Content logs\stderr.log -Tail 50"
  }
} else {
  Write-Host ""
  Write-Host "Update complete." -ForegroundColor Green
  if ($svc) {
    Write-Host "(PumpDirect service is installed but was not running. Start it with: Start-Service PumpDirect)"
  } else {
    Write-Host "(Run start.bat to launch.)"
  }
}

Write-Host ""
Read-Host "Press Enter to close"

@echo off
setlocal
title PumpDirect

set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

echo.
echo ========================================
echo   PumpDirect
echo ========================================
echo.

REM Service conflict check - the OS-hardened PumpDirect service binds the same
REM ports, so running this launcher alongside it would crash immediately with
REM EADDRINUSE and the cmd window would close before the error is readable.
sc query PumpDirect 2>nul | findstr /C:"RUNNING" >nul
if not errorlevel 1 (
    echo.
    echo ========================================
    echo   PumpDirect service is already RUNNING
    echo ========================================
    echo.
    echo The OS-hardened Windows Service is already running PumpDirect, so
    echo this launcher cannot start - port 3000/3001 are already bound.
    echo.
    echo Either:
    echo   1^) Use the service directly - open http://localhost:3001 in a browser.
    echo      To stop it:    Stop-Service PumpDirect    ^(admin PowerShell^)
    echo      To restart it: Restart-Service PumpDirect ^(admin PowerShell^)
    echo.
    echo   2^) Or stop the service and re-run this launcher to take updates:
    echo      Stop-Service PumpDirect
    echo      start.bat
    echo.
    pause
    exit /b 1
)

REM Node check
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js not found. Install Node 20+ from https://nodejs.org and re-run.
    pause
    exit /b 1
)

REM Python check (optional)
where python >nul 2>nul
if errorlevel 1 (
    echo Warning: python not found. Some device protocols ^(Wyze, Matter, Kasa^) will be unavailable.
)

REM Auto-update from origin/main (if this is a git checkout and git is available).
REM Skipped on dirty trees - users aren't expected to edit code locally.
set NEED_DEPS_REINSTALL=
where git >nul 2>nul
if errorlevel 1 goto :no_update
if not exist ".git" goto :no_update

echo Checking for updates...
git diff --quiet
if errorlevel 1 goto :dirty_tree
git diff --cached --quiet
if errorlevel 1 goto :dirty_tree

git fetch --quiet origin 2>nul
if errorlevel 1 (
    echo Warning: cannot reach git remote ^(offline?^). Launching current version.
    goto :no_update
)

for /f %%i in ('git rev-parse HEAD') do set LOCAL_SHA=%%i
for /f %%i in ('git rev-parse origin/main 2^>nul') do set REMOTE_SHA=%%i
if "%LOCAL_SHA%"=="%REMOTE_SHA%" (
    echo Already up to date.
    goto :no_update
)

echo Updating to latest...
git pull --ff-only --quiet origin main
if errorlevel 1 (
    echo Warning: update failed ^(diverged history^). Launching current version.
    goto :no_update
)
echo Updated. Reinstalling dependencies...
set NEED_DEPS_REINSTALL=1
goto :no_update

:dirty_tree
echo Warning: local uncommitted changes - skipping auto-update.
echo   To force update, discard local edits: git reset --hard origin/main

:no_update

REM Install node deps if missing OR if we just pulled an update
if not exist "node_modules" set NEED_NODE_INSTALL=1
if defined NEED_DEPS_REINSTALL set NEED_NODE_INSTALL=1
if defined NEED_NODE_INSTALL (
    echo Installing Node dependencies...
    call npm install --no-audit --no-fund --loglevel=error
)
set NEED_NODE_INSTALL=

REM Python venv (optional)
if exist "requirements.txt" (
    where python >nul 2>nul
    if not errorlevel 1 (
        if not exist ".venv" (
            echo Creating Python venv...
            python -m venv .venv
        )
        if defined NEED_DEPS_REINSTALL if exist ".venv\.deps-installed" del ".venv\.deps-installed"
        if not exist ".venv\.deps-installed" (
            echo Installing Python dependencies...
            call .venv\Scripts\pip install --quiet --upgrade pip
            call .venv\Scripts\pip install --quiet -r requirements.txt
            type nul > .venv\.deps-installed
        )
    )
)

if not defined OWNER_PORT set OWNER_PORT=3001
if not defined PORT set PORT=3000
set OWNER_URL=http://localhost:%OWNER_PORT%

echo.
echo Owner GUI: %OWNER_URL%
echo Public server ^(loopback^): http://localhost:%PORT%
echo.

REM Open owner URL after a short delay
start "" /b cmd /c "timeout /t 3 /nobreak >nul && start """" %OWNER_URL%"

node server.js
set NODE_EXIT=%errorlevel%
if not "%NODE_EXIT%"=="0" (
    echo.
    echo ========================================
    echo   PumpDirect exited with code %NODE_EXIT%
    echo ========================================
    echo.
    echo Common causes:
    echo   - Port 3000 or 3001 already in use ^(another launcher or the service^)
    echo   - npm install never completed ^(delete node_modules and re-run^)
    echo   - Code error ^(scroll up for the stack trace^)
    echo.
    pause
)
endlocal

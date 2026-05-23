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
endlocal

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

REM Install node deps if missing
if not exist "node_modules" (
    echo Installing Node dependencies...
    call npm install --no-audit --no-fund --loglevel=error
)

REM Python venv (optional)
if exist "requirements.txt" (
    where python >nul 2>nul
    if not errorlevel 1 (
        if not exist ".venv" (
            echo Creating Python venv...
            python -m venv .venv
        )
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

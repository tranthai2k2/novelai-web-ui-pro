@echo off
setlocal
chcp 65001 >nul
title NovelAI Web UI Pro - Setup and Run
color 0A

pushd "%~dp0"

echo.
echo ============================================================
echo   NovelAI Web UI Pro - Setup and Installation
echo ============================================================
echo.

echo [1/3] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not available in PATH.
    echo Install Node.js from https://nodejs.org/
    echo.
    pause
    popd
    exit /b 1
)

for /f "delims=" %%i in ('node --version') do set "NODE_VERSION=%%i"
echo [OK] Node.js %NODE_VERSION% detected

echo [2/3] Checking npm...
where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm is not installed or not available in PATH.
    echo.
    pause
    popd
    exit /b 1
)

for /f "delims=" %%i in ('npm --version') do set "NPM_VERSION=%%i"
echo [OK] npm %NPM_VERSION% detected

echo.
echo [3/3] Installing npm dependencies...t
echo.
call npm.cmd install
if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    echo Check the error output above.
    echo.
    pause
    popd
    exit /b 1
)

echo.
echo ============================================================
echo   Installation completed
echo ============================================================
echo.
echo Available commands:
echo   npm run dev
echo   npm run build
echo   npm run preview
echo   npm run lint
echo   python main.py
echo.
echo Starting development server in this terminal only...
echo Opening browser...
start "" http://localhost:3000
echo.
echo Server should be available at http://localhost:3000
echo Close this terminal window to stop it.
echo.
npm.cmd run dev

:cleanup
popd
endlocal

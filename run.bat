@echo off
setlocal
chcp 65001 >nul
title NovelAI Web UI Pro - Setup and Run
color 0A

pushd "%~dp0"

echo.
echo ============================================================
echo   NovelAI Web UI Pro - Setup and Run
echo ============================================================
echo.

powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\bootstrap-runtime.ps1" -Mode Run
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Startup failed.
    echo.
    pause
)

popd
endlocal
exit /b %EXIT_CODE%

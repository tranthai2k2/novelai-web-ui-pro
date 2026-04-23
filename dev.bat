@echo off
setlocal
chcp 65001 >nul
title NovelAI Web UI Pro - Development Mode
color 0A

pushd "%~dp0"

echo.
echo ============================================================
echo   NovelAI Web UI Pro - Development Mode
echo ============================================================
echo.

powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\bootstrap-runtime.ps1" -Mode Dev
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" (
    echo Dev server started in a new window.
) else (
    echo [ERROR] Development mode failed to start.
)

echo.
pause

popd
endlocal
exit /b %EXIT_CODE%

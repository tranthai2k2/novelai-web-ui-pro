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
echo Starting TypeScript + React server...
echo.

start "NovelAI Dev Server" cmd /k "cd /d %~dp0 && npm.cmd run dev"

echo Waiting 3 seconds...
timeout /t 3 /nobreak >nul

echo Opening browser...
start "" http://localhost:3000

echo.
echo Server should be available at http://localhost:3000
echo Close the "NovelAI Dev Server" window to stop it.
echo.
pause

popd
endlocal

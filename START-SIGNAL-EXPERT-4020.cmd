@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 22.5 or newer is required.
  echo Download it from https://nodejs.org/
  echo.
  pause
  exit /b 1
)
node launcher.mjs --instance phase2 --port 4020 --strict-port --database data/instances/phase2/signal-expert.db --stream
if errorlevel 1 pause

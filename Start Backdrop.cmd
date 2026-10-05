@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Backdrop needs Node.js to run its local server. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node serve.mjs --open
pause

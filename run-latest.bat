@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)
echo Rebuilding the latest page...
call npm run build
if errorlevel 1 (
  echo Build failed. Please review the error above.
  pause
  exit /b 1
)
echo Starting the latest preview. Close this window to stop it.
start "" http://127.0.0.1:4173
call npm run serve

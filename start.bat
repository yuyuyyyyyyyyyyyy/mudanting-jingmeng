@echo off
call "%~dp0run-latest.bat"
exit /b %errorlevel%
cd /d %~dp0
cd /d %~dp0
goto launch
if not exist node_modules (
  echo 首次运行，正在安装依赖...
  npm install
)
goto launch
if not exist dist (
  npm run build
)
echo.
echo 牡丹亭 · 惊梦 —— 即将在浏览器打开 http://127.0.0.1:4173
echo 关闭此窗口即停止服务。
start "" http://127.0.0.1:4173
npm run preview

:launch
echo Rebuilding the latest page...
call npm run build
if errorlevel 1 (
  echo Build failed. Please review the error above.
  pause
  exit /b 1
)
echo.
echo The browser will open after the preview server is ready.
echo Close this window to stop the server.
call npm run preview -- --open

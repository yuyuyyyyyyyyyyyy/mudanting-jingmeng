@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 牡丹亭 · 公网启动

echo ==============================
echo   牡丹亭 · 一键启动公网服务
echo ==============================
echo.
echo [1/3] 清理占用 4175 的旧进程...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":4175" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [2/3] 启动本地服务 server.mjs ...
start "mudanting-server" cmd /k "node server.mjs"
timeout /t 2 /nobreak >nul

echo [3/3] 启动 cpolar 公网隧道 ...
echo.
echo  请在本窗口下方找到公网地址（形如 https://xxxx.r8.cpolar.cn）
echo  关闭本窗口 = 停止公网访问
echo.
".tools\cpolar\bin\cpolar\cpolar.exe" http 4175 -region cn

pause

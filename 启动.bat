@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM 关键：接上随项目打包的 Chromium（否则 patchright 会去默认缓存目录找，找不到）
set PLAYWRIGHT_BROWSERS_PATH=%~dp0browsers

echo.
echo   TikTok 多账号数据抓取服务（本地版 / 一键启动）
echo   ----------------------------------------------
echo.

REM 1) 检查 Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没检测到 Node.js。
  echo   请先装一个： https://nodejs.org  （选 LTS，安装时务必勾选 "Add to PATH"）
  echo   装完重开此窗口，再双击本文件即可。
  echo.
  pause
  exit /b 1
)

REM 2) 首次安装依赖（仅一次）
if not exist node_modules (
  echo   首次运行：安装依赖（约 1-2 分钟，只需一次）...
  call npm install --no-audit --no-fund
  echo.
)

REM 3) 确保 Chromium 已就绪（本地有就跳过，没有才联网下载 ~150MB）
node -e "const fs=require('fs'),p=require('path');const b=p.join(__dirname,'browsers');const ok=fs.readdirSync(b).some(d=>['chrome-win64/chrome.exe','chrome-macos/Chrome','chrome-linux/chrome'].some(f=>fs.existsSync(p.join(b,d,f))));process.exit(ok?0:1)" || (
  echo   下载 Chromium（首次约 150MB，需联网）...
  call npx patchright install chromium
)

REM 4) 启动（浏览器会自动打开）
echo   启动中...
echo.
node server.js
pause

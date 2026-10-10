#!/bin/bash
cd "$(dirname "$0")"

# 关键：接上随项目打包的 Chromium
export PLAYWRIGHT_BROWSERS_PATH="$(dirname "$0")/browsers"

echo ""
echo "  TikTok 多账号数据抓取服务（本地版 / 一键启动）"
echo "  ----------------------------------------------"
echo ""

# 1) 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "  [错误] 未检测到 Node.js。"
  echo "  请先安装： https://nodejs.org （选 LTS 版）"
  echo "  或终端执行： brew install node"
  echo ""
  read -p "  按回车退出"
  exit 1
fi

# 2) 首次安装依赖（仅一次）
if [ ! -d node_modules ]; then
  echo "  首次运行：安装依赖（约 1-2 分钟，只需一次）..."
  npm install --no-audit --no-fund
  echo ""
fi

# 3) 确保 Chromium 已就绪
node -e "const fs=require('fs'),p=require('path');const b=p.join(__dirname,'browsers');const ok=fs.readdirSync(b).some(d=>['chrome-win64/chrome.exe','chrome-macos/Chrome','chrome-linux/chrome'].some(f=>fs.existsSync(p.join(b,d,f))));process.exit(ok?0:1)" || {
  echo "  下载 Chromium（首次约 150MB，需联网）..."
  npx patchright install chromium
}

# 4) 启动（浏览器会自动打开）
echo "  启动中..."
echo ""
node server.js
read -p "  按回车退出"

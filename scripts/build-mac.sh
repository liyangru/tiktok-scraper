#!/usr/bin/env bash
# ============================================================
# macOS 一键构建：TikTokScraper-<版本>-<架构>-mac.zip（2.0 极简分析版）
#
# ⚠️ 必须在 macOS 上运行（electron-builder 禁止在 Windows/Linux 出 mac 包；
#    Apple Silicon 要求 app 至少 ad-hoc 签名，签名只能用 macOS 的 codesign）。
#
# 2.0 起**不再需要浏览器载荷**：无 Chromium / 无 playwright / 无 ffmpeg，
# 所以这一步整段删掉，构建更快、包更小。
#
# 用法：  bash scripts/build-mac.sh
# 可选：  ARCHS="arm64" bash scripts/build-mac.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

ARCHS="${ARCHS:-arm64 x64}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "❌ 本脚本必须在 macOS 上运行（当前系统：$(uname -s)）。"
  exit 1
fi

echo "==> 1/4 安装依赖"
npm install --no-audit --no-fund

echo "==> 2/4 生成图标（build/icon.png）"
node scripts/make-icon.js || echo "   （图标生成失败，沿用已有图标）"

echo "==> 3/4 打包模块（ai-analyst）"
node scripts/build-modules.js --local

echo "==> 4/4 electron-builder 打包（$ARCHS）"
for arch in $ARCHS; do
  echo "   → 构建 $arch ..."
  npx electron-builder --mac zip --"$arch" --publish never -c.directories.output=release-mac
done

echo ""
echo "==> 补一次 ad-hoc 签名（Apple Silicon 必需）"
for app in release-mac/mac*/*.app; do
  [ -d "$app" ] || continue
  codesign --force --deep --sign - "$app" && echo "   已签名: $app"
done

echo ""
echo "✅ 完成，产物在 release-mac/ ："
ls -la release-mac/*.zip 2>/dev/null || ls -la release-mac/
echo ""
echo "分发提醒：首次打开若提示「无法验证开发者」——"
echo "  右键点 App → 打开；或执行  xattr -dr com.apple.quarantine /Applications/TikTokScraper.app"

#!/usr/bin/env bash
# ============================================================
# macOS 一键构建：TikTokScraper-<版本>-<架构>-mac.zip
#
# ⚠️ 必须在 macOS 上运行（electron-builder 明确禁止在 Windows/Linux 上出 mac 包；
#    而且 Apple Silicon 要求 app 至少做 ad-hoc 签名，签名只能用 macOS 的 codesign）。
#
# 用法：  bash scripts/build-mac.sh
# 可选：  ARCHS="arm64" bash scripts/build-mac.sh      # 只出 Apple Silicon
#        ARCHS="x64"   bash scripts/build-mac.sh      # 只出 Intel
#
# 浏览器载荷（browser-payload-mac-<arch>.tar.gz）若已存在就直接复用；
# 缺失且与当前机器架构一致时，会用 patchright 现场下载并打包。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

ARCHS="${ARCHS:-arm64 x64}"
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  arm64) HOST="arm64" ;;
  x86_64) HOST="x64" ;;
  *) HOST="$HOST_ARCH" ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "❌ 本脚本必须在 macOS 上运行（当前系统：$(uname -s)）。"
  exit 1
fi

echo "==> 1/5 安装依赖"
npm install --no-audit --no-fund

echo "==> 2/5 生成图标（build/icon.png）"
node scripts/make-icon.js || echo "   （图标生成失败，沿用已有图标）"

echo "==> 3/5 准备各架构浏览器载荷"
# 版本对齐说明：抓取用 patchright 驱动，但「能过 TikTok」的那个 Chromium 是
# playwright 1.64 对应的 chromium-1248（Chrome for Testing 156.0.8078.4）——
# Windows 版就是用这个版本实测抓通的。所以这里用 playwright 的安装器，
# 而不是 patchright 的（patchright 1.63 自带的是 chromium-1243 / Chrome 153，版本对不上）。
for arch in $ARCHS; do
  out="browser-payload-mac-${arch}.tar.gz"
  if [ -f "$out" ]; then
    echo "   [已有] $out ($(du -sh "$out" | cut -f1))"
    continue
  fi
  if [ "$arch" != "$HOST" ]; then
    echo "   [跳过] $out 缺失，且本机架构是 $HOST —— 无法交叉生成 $arch 的浏览器"
    continue
  fi
  echo "   [下载] 取本机架构 chromium（playwright chromium-1248 / CfT 156.0.8078.4）..."
  BPDIR="$PWD/.mac-browsers-$arch"
  PLAYWRIGHT_BROWSERS_PATH="$BPDIR" npx playwright install chromium
  chr="$(ls -d "$BPDIR"/chromium-* 2>/dev/null | head -1)"
  if [ -z "$chr" ]; then echo "   ❌ chromium 下载失败"; exit 1; fi
  tar -czf "$out" -C "$BPDIR" "$(basename "$chr")"
  echo "   [完成] $out ($(du -sh "$out" | cut -f1))"
done

echo "==> 4/5 electron-builder 打包"
BUILT=0
for arch in $ARCHS; do
  payload="browser-payload-mac-${arch}.tar.gz"
  if [ ! -f "$payload" ]; then
    echo "   [跳过] $arch：缺少 $payload"
    continue
  fi
  echo "   → 构建 $arch ..."
  cp -f "$payload" browser-payload.tar.gz
  npx electron-builder --mac zip --"$arch" --publish never -c.directories.output=release-mac
  BUILT=$((BUILT + 1))
done

if [ "$BUILT" -eq 0 ]; then echo "❌ 没有任何架构被构建"; exit 1; fi

echo "==> 5/5 补一次 ad-hoc 签名（Apple Silicon 必需）"
for app in release-mac/mac*/*.app; do
  [ -d "$app" ] || continue
  codesign --force --deep --sign - "$app" && echo "   已签名: $app"
done

echo ""
echo "✅ 完成，产物在 release-mac/ ："
ls -la release-mac/*.zip 2>/dev/null || ls -la release-mac/
echo ""
echo "分发给别人时提醒：首次打开若提示「无法验证开发者」——"
echo "  右键点 App → 打开；或执行  xattr -dr com.apple.quarantine /Applications/TikTokScraper.app"

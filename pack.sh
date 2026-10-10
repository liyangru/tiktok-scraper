#!/usr/bin/env bash
# 打包项目用于上传到服务器（排除 node_modules / 数据 / 密钥）
# 用法: bash pack.sh    → 生成 tiktok-scraper.tar.gz
set -e
cd "$(dirname "$0")"
OUT="../tiktok-scraper.tar.gz"
rm -f "$OUT"
tar \
  --exclude=./node_modules \
  --exclude=./data \
  --exclude=./.env \
  --exclude=./package-lock.json \
  -czf "$OUT" .
echo "✓ 已生成: $(cd .. && pwd)/tiktok-scraper.tar.gz"
echo "  大小: $(du -h "$OUT" | cut -f1)"
echo ""
echo "  上传到服务器："
echo "    scp tiktok-scraper.tar.gz root@<服务器IP>:/root/"
echo "  然后在服务器上："
echo "    mkdir -p /root/tiktok-scraper && tar -xzf /root/tiktok-scraper.tar.gz -C /root/tiktok-scraper"
echo "    cd /root/tiktok-scraper && bash tencent-setup.sh"

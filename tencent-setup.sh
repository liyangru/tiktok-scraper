#!/usr/bin/env bash
# ============================================================
#  TikTok 抓取服务 —— 腾讯云服务器一键部署脚本
#  在服务器上执行：  bash tencent-setup.sh
#
#  ⚠️ 前提：服务器必须是【海外/港澳台节点】
#     香港 / 新加坡 / 曼谷 / 硅谷 等。
#     中国内地节点无法访问 TikTok，部署完也是摆设。
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"

echo ""
echo "=========================================="
echo "  TikTok 抓取服务 · 服务器部署"
echo "=========================================="
echo ""

# ---------- 1. 检查系统 ----------
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "✗ 这个脚本只能在 Linux 服务器上跑"
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  SUDO="sudo"
else
  SUDO=""
fi

ARCH=$(uname -m)
echo "  系统: $(uname -srm)"

# ---------- 2. 装 Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  echo ""
  echo "→ 未检测到 Docker，开始安装..."
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq ca-certificates curl gnupg
  # 用腾讯云内网镜像，海外节点也通
  curl -fsSL https://mirrors.cloud.tencent.com/docker-ce/linux/ubuntu/gpg 2>/dev/null \
    | $SUDO gpg --dearmor -o /usr/share/keyrings/docker.gpg 2>/dev/null \
    || curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | $SUDO gpg --dearmor -o /usr/share/keyrings/docker.gpg

  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] \
https://mirrors.cloud.tencent.com/docker-ce/linux/${ID} ${VERSION_CODENAME} stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null

  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  $SUDO systemctl enable --now docker
  echo "✓ Docker 安装完成"
else
  echo "✓ Docker 已安装: $(docker --version)"
fi

# ---------- 3. 访问口令 ----------
if [[ ! -f .env ]]; then
  TOKEN="${ACCESS_TOKEN:-}"
  if [[ -z "$TOKEN" ]]; then
    TOKEN=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
    echo ""
    echo "  已自动生成访问口令: $TOKEN"
    echo "  （想自己指定就重跑：ACCESS_TOKEN=你的口令 bash tencent-setup.sh）"
  fi
  echo "ACCESS_TOKEN=$TOKEN" > .env
  chmod 600 .env
else
  echo "✓ 已有 .env，沿用里面的 ACCESS_TOKEN"
fi
TOKEN=$(grep '^ACCESS_TOKEN=' .env | cut -d= -f2-)

# ---------- 4. 构建并启动 ----------
echo ""
echo "→ 构建镜像（首次约 3-6 分钟，要下载 Chromium）..."
$SUDO docker compose up -d --build

# ---------- 5. 自检 ----------
echo ""
echo "→ 等待服务就绪..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:8899/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo ""
echo "  ── 容器内自检 ──"
curl -s http://127.0.0.1:8899/api/health || echo "  ✗ 健康检查失败"
echo ""

# ---------- 6. 拿公网 IP ----------
IP=$(curl -s --max-time 5 https://api.ipify.org || curl -s --max-time 5 ifconfig.me || echo "<服务器公网IP>")

echo ""
echo "=========================================="
echo "  ✅ 部署完成"
echo "=========================================="
echo ""
echo "  访问地址:  http://${IP}:8899/?token=${TOKEN}"
echo ""
echo "  首次访问会种下 cookie，之后直接开 http://${IP}:8899/ 即可"
echo ""
echo "  ⚠️ 别忘了在【腾讯云控制台 → 防火墙/安全组】放行 TCP 8899"
echo ""
echo "  常用命令："
echo "    查看日志   sudo docker compose logs -f"
echo "    重启       sudo docker compose restart"
echo "    停止       sudo docker compose down"
echo "    更新代码后 sudo docker compose up -d --build"
echo ""

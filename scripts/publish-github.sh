#!/usr/bin/env bash
# ============================================================
# 把本项目推到 GitHub，并可选地打 tag 触发全平台构建
#
# 用法（二选一）：
#   # A. 用 gh 登录态（推荐，不会把 token 写进任何文件）
#   gh auth login
#   bash scripts/publish-github.sh <owner>/<repo> [tag]
#
#   # B. 用环境变量传 token（不会写进 .git/config，只在本次命令里用）
#   GITHUB_TOKEN=ghp_xxx bash scripts/publish-github.sh <owner>/<repo> [tag]
#
# 例子：
#   bash scripts/publish-github.sh myname/tiktok-scraper            # 只推代码
#   bash scripts/publish-github.sh myname/tiktok-scraper v1.0.0     # 推代码 + 打 tag 出全平台包
#
# 可选环境变量：
#   VISIBILITY=public|private   仓库可见性（默认 private）
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

SLUG="${1:-}"
TAG="${2:-}"
VISIBILITY="${VISIBILITY:-private}"

if [ -z "$SLUG" ]; then
  echo "用法: bash scripts/publish-github.sh <owner>/<repo> [tag]"
  exit 2
fi

OWNER="${SLUG%%/*}"
REPO="${SLUG##*/}"

# ---- 取 token ----
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi
if [ -z "$TOKEN" ]; then
  echo "❌ 没有可用的 GitHub 凭据。"
  echo "   先执行 'gh auth login'，或设置 GITHUB_TOKEN 环境变量后重试。"
  exit 1
fi
echo "==> 凭据就绪（token 长度 ${#TOKEN}）"

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
      -d "$body" "https://api.github.com$path"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com$path"
  fi
}

# ---- 仓库不存在则创建 ----
echo "==> 检查仓库 $SLUG"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/$SLUG")"
if [ "$CODE" = "200" ]; then
  echo "    仓库已存在，直接推送"
elif [ "$CODE" = "404" ]; then
  echo "    仓库不存在，正在创建（$VISIBILITY）..."
  if [ "$OWNER" = "$(api GET /user | sed -n 's/.*"login": *"\([^"]*\)".*/\1/p' | head -1)" ]; then
    api POST /user/repos "{\"name\":\"$REPO\",\"private\":$([ "$VISIBILITY" = private ] && echo true || echo false),\"description\":\"TikTok 多账号视频数据抓取：Electron 桌面应用 + pkg 单文件 exe，跨平台\"}" \
      | grep -q '"full_name"' && echo "    创建成功" || { echo "    ❌ 创建失败"; exit 1; }
  else
    api POST "/orgs/$OWNER/repos" "{\"name\":\"$REPO\",\"private\":$([ "$VISIBILITY" = private ] && echo true || echo false)}" \
      | grep -q '"full_name"' && echo "    创建成功" || { echo "    ❌ 创建失败（组织权限？）"; exit 1; }
  fi
else
  echo "    ❌ 无法访问仓库（HTTP $CODE），检查 token 权限（需要 repo 权限）"
  exit 1
fi

# ---- 推代码 ----
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "==> 推送分支 $BRANCH"
# 注意：用一次性 URL 推送，token 不会写进 .git/config
git push "https://x-access-token:${TOKEN}@github.com/${SLUG}.git" "HEAD:refs/heads/${BRANCH}"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/${SLUG}.git"
echo "    已推送并设置 origin"

# ---- 打 tag 触发构建 ----
if [ -n "$TAG" ]; then
  echo "==> 打 tag $TAG 并推送（会触发 release 工作流：Win + mac arm64/x64 + 部署包）"
  git tag -f "$TAG"
  git push "https://x-access-token:${TOKEN}@github.com/${SLUG}.git" "refs/tags/${TAG}"
  echo ""
  echo "✅ 完成。构建进度："
  echo "   https://github.com/${SLUG}/actions"
  echo "构建完成后自动发布 Release："
  echo "   https://github.com/${SLUG}/releases/tag/${TAG}"
else
  echo ""
  echo "✅ 完成。仓库：https://github.com/${SLUG}"
  echo "要出全平台安装包，再跑一次并带上 tag："
  echo "   bash scripts/publish-github.sh ${SLUG} v1.0.0"
fi

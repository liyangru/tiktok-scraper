#!/usr/bin/env bash
# ============================================================
# 把本项目推到 GitHub，并可选地打 tag 触发全平台构建
#
# 用法：
#   bash scripts/publish-github.sh <owner>/<repo> [tag]
#
# 例子：
#   bash scripts/publish-github.sh myname/tiktok-scraper            # 只推代码
#   bash scripts/publish-github.sh myname/tiktok-scraper v1.0.0     # 推代码 + 打 tag 出全平台包
#
# 凭据（二选一）：
#   A. 先 `gh auth login`（推荐）
#   B. 设环境变量 GITHUB_TOKEN
#
# ⚠️ 关键坑：token 必须有 **workflow** scope，否则 GitHub 会拒绝推送
#    `.github/workflows/` 下的文件：
#      refusing to allow an OAuth App to create or update workflow ... without workflow scope
#    gh 的默认 token 只有 gist/read:org/repo，所以要补一次：
#      gh auth refresh --hostname github.com --scopes workflow
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
  echo "例:   bash scripts/publish-github.sh myname/tiktok-scraper v1.0.0"
  exit 2
fi

case "$VISIBILITY" in
  public|private) ;;
  *) echo "❌ VISIBILITY 只能是 public 或 private"; exit 2 ;;
esac

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HAVE_GH=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  HAVE_GH=1
fi

# ---- 检查 workflow 权限（最容易踩的坑，提前拦） ----
check_workflow_scope() {
  local scopes="$1"
  case "$scopes" in
    *workflow*) return 0 ;;
    *)
      echo "❌ 凭据缺少 workflow 权限，无法推送 .github/workflows/ 下的文件。"
      echo "   补一次即可： gh auth refresh --hostname github.com --scopes workflow"
      echo "   （或给 PAT 勾上 workflow 权限）"
      exit 1
      ;;
  esac
}

if [ "$HAVE_GH" = "1" ]; then
  echo "==> 使用 gh 登录态"
  check_workflow_scope "$(gh auth status 2>&1 | grep -i 'Token scopes' | head -1)"
  gh auth setup-git

  if gh repo view "$SLUG" >/dev/null 2>&1; then
    echo "    仓库已存在：$SLUG"
    git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/${SLUG}.git"
  else
    echo "    创建仓库（$VISIBILITY）并推送 ..."
    gh repo create "$SLUG" "--$VISIBILITY" --source=. --remote=origin --push \
      --description "TikTok 多账号视频数据抓取：Electron 桌面应用 + pkg 单文件 exe，跨平台"
  fi
  echo "==> 推送分支 $BRANCH"
  git push origin "$BRANCH"

else
  # ---- 没有 gh：走 token + REST API ----
  TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [ -z "$TOKEN" ]; then
    echo "❌ 没有可用的 GitHub 凭据。"
    echo "   先执行 'gh auth login'，或设置 GITHUB_TOKEN 环境变量后重试。"
    exit 1
  fi
  echo "==> 使用 GITHUB_TOKEN"

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

  LOGIN="$(api GET /user | sed -n 's/.*"login": *"\([^"]*\)".*/\1/p' | head -1)"
  OWNER="${SLUG%%/*}"
  REPO="${SLUG##*/}"
  echo "    已认证为 $LOGIN"

  CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
    "https://api.github.com/repos/$SLUG")"
  if [ "$CODE" = "200" ]; then
    echo "    仓库已存在"
  elif [ "$CODE" = "404" ]; then
    echo "    创建仓库（$VISIBILITY）..."
    PRIVATE=false; [ "$VISIBILITY" = "private" ] && PRIVATE=true
    BODY="{\"name\":\"$REPO\",\"private\":$PRIVATE}"
    if [ "$OWNER" = "$LOGIN" ]; then
      api POST /user/repos "$BODY" | grep -q '"full_name"' || { echo "    ❌ 创建失败"; exit 1; }
    else
      api POST "/orgs/$OWNER/repos" "$BODY" | grep -q '"full_name"' || { echo "    ❌ 创建失败（组织权限？）"; exit 1; }
    fi
    echo "    创建成功"
  else
    echo "    ❌ 无法访问仓库（HTTP $CODE），检查 token 的 repo 权限"
    exit 1
  fi

  echo "==> 推送分支 $BRANCH"
  # 一次性 URL，token 不写进 .git/config
  git push "https://x-access-token:${TOKEN}@github.com/${SLUG}.git" "HEAD:refs/heads/${BRANCH}"
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/${SLUG}.git"
fi

# ---- 打 tag 触发全平台构建 ----
if [ -n "$TAG" ]; then
  echo "==> 打 tag $TAG 并推送（触发 release 工作流：Win×2 + mac arm64/x64 + 部署包）"
  git tag -f "$TAG"
  git push -f origin "refs/tags/${TAG}"
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

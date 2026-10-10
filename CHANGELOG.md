# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 和 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。

## 版本迭代怎么做

1. **改代码**，并在本文件顶部的 `## [Unreleased]` 区块里记一笔（分类：`新增 / 变更 / 修复 / 移除 / 安全`）。
   - 没打算发版就先留在 `Unreleased`，**不要为了发版而发版**。
2. **确定要发版时**：把 `## [Unreleased]` 改名为 `## [x.y.z] - YYYY-MM-DD`，并在最上面新开一个空的 `## [Unreleased]`；同步改 `package.json` 的 `version`。
3. **提交并打 tag**：

   ```bash
   git add -A && git commit -m "release: v1.0.2"
   git tag v1.0.2 && git push origin master --tags
   ```

4. CI（`.github/workflows/release.yml`）会自动：构建 Windows / macOS / 部署包 → **从本文件抽取对应版本的段落作为 Release 说明** → 发 Release。
   - 若某个 tag 在本文件里找不到对应段落，会自动回退成 GitHub 的 `--generate-notes`（按 commit 生成）。

> ⚠️ tag 名要和本文件的标题对得上：tag `v1.0.2` ↔ 标题 `## [1.0.2]`。对不上就抽不到，会走回退逻辑。

> 🚫 **不要自作主张删除旧版本。** 旧版本的 Release 和 tag **默认全部保留**，方便回溯、回滚到任意一版；
> 只有明确要求删掉某个版本时才删。新版本正常发布即可，GitHub 会自动把最新的一版标为 Latest。

---

## [Unreleased]

### 变更

- **Release 说明自动从本文件抽取**：`release.yml` 会读取 tag 对应版本（如 `v1.0.2` → `## [1.0.2]`）的段落，拼上下载表后作为 Release 正文；抽不到就回退成按 commit 自动生成。以后每个版本的改动都会自动记录在 Release 里。
- **README 重写为仓库主页**：加界面截图、下载入口、功能清单、目录结构；把构建 / 部署等开发者细节收进折叠区块。
- 补 `LICENSE`（MIT）。
- 仓库清理：删掉一次性脚本 `_del_nul.py` 与重复的 `启动.bat`；`test_headless.js` / `test_one.js` 移入 `scripts/`（改名为 `test-headless.js` / `diagnose-one.js`）。

## [1.0.1] - 2026-10-10

### 修复

- **Windows 安装包体积从 515MB 回到 311MB**：`build.files` 里排除了 `.mac-browsers/` 却漏了 `.win-browsers/`，导致 CI 上 Windows job 下载的 Chromium 被 `**/*` 整个打进 asar（未压缩约 450MB，压完 +204MB）。
  - 同时补上 `!.*-browsers/**` 通配与 `!out/**`，避免同类问题再犯。
- **macOS 构建失败**：`electron-builder` 检测到当前在 git tag 上会自动尝试发布到 GitHub Releases（`Implicit publishing triggered by git tag`），无 `GH_TOKEN` 即报错退出 —— 尽管 zip 其实已经打好了。已在所有调用处显式加 `--publish never`。

### 变更

- GitHub Actions 升级到最新主版本：`checkout@v7`、`setup-node@v7`、`upload-artifact@v7`、`download-artifact@v8`（v4 系列基于已弃用的 Node 20）。
- `scripts/publish-github.sh` 优先走 `gh` 登录态，并在开跑前检查 `workflow` scope（缺了会被 GitHub 拒绝推送工作流文件）。

## [1.0.0] - 2026-10-10

### 新增

- **抓取引擎**：用 Patchright 驱动真实 Chromium，拦截 TikTok 自己的 `/api/post/item_list` 响应，直接拿官方原始 JSON —— 不是爬 HTML。
- **桌面应用（Electron，推荐）**：独立应用窗口，无命令行黑框、无浏览器外壳、无「Chrome 测试版」横幅；单实例；关窗即退出；导出文件自动落到系统「下载」目录。
- **单文件 exe（pkg 版）**：`tiktok-scraper.exe` 双击即跑，目标机器**不需要装 Node.js 也不需要 Chrome**；GUI 子系统（无黑框），自带 Chromium 以 `--app` 模式开独立窗口。
- **macOS 版**：arm64 + x64 两个包，自带浏览器，ad-hoc 签名。
- **自带浏览器**：所有发行版都把 Chromium 打进包里（Windows 440MB / macOS 约 200MB），运行时不联网下载、不回退系统浏览器。
- **界面**：极简黑白灰；三语（中文 / ไทย / English）；加载骨架屏、账号标签页、搜索、按任意列排序；导出 Excel / CSV。
- **抓取能力**：多账号、日期区间筛选、按播放量排序、互动率计算、粉丝数。
- **跨平台构建**：`lib/browsers.js` 统一探测 Windows / macOS / Linux 的浏览器布局；`scripts/build-mac.sh` 在 Mac 上一键出包。
- **CI**：`release.yml` 打 tag 出全平台安装包并自动发 Release；`build-mac.yml` 单独出 macOS 包。

### 说明

- 单账号抓取约 20–90 秒，取决于视频数量。
- 并发必须保持 `1`：多会话同时请求时 TikTok 不返回数据。
- 抓不到私密/已删除视频与评论区数据；播放量是 TikTok 公开口径，与后台真实数据会有偏差。

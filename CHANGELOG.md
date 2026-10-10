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

### 新增

- **卖家中心「套壳」导出（放弃 API 后的替代路线）**：在应用里开一个独立的卖家中心浏览器窗口
  （独立 profile，**登录一次就记住**），你在页面里把日期调好点导出，模块监听下载事件把 xlsx
  **自动接住、自动解析、自动入库** —— 和手动导入走同一条管线，交叉分析立即可用。
  - 不逆向卖家中心内部接口（会变、易封），只接它自己的导出文件，最稳。
  - 修复：模块开浏览器必须传 `executablePath`（系统 Chrome），否则 patchright 找不到自带的 chromium。
- **卖家中心导入与挂车分析（模块）**：导入卖家中心「视频表现」xlsx → 按**视频ID**与应用抓到的 TikTok 视频交叉匹配。
  落实核心数据原则：**TikTok 为主、卖家中心只补商家指标、绝不能反过来**（卖家中心混着广告计划/混剪视频）。
  - 匹配上的 = 挂车（补 GMV/订单/商品点击/GPM）；TikTok 有而卖家中心没有 = 没挂车；
    卖家中心有而 TikTok 没有 = 广告/混剪，**自动剔除**
  - 交叉校验：item_list 的 `isECVideo` 与卖家中心匹配结果比对（实测 9 条里 8 条一致 —— 以后者为准）
  - 解析按**表头名**定位列（不按列序号），兼容卖家中心改列序；表头在第 3 行、数据从第 4 行、第 1 行是日期范围
  - 实测：日期内 TikTok 9 条 → 挂车 7 / 非挂车 2 / 剔除 268；商品点击 挂车 19 vs 非挂车 0
- **模块前端装载机制**：`window.TTModule.register()` + `#module-panels` 挂载点，已启用模块的面板自动进主界面
- **设置界面**：顶栏「设置」→ 模块列表（下载安装即启用 / 启停 / 删除），带三语引导与安全提示
- **安装即启用**：下载安装自动级联启用依赖，重启生效；可删除
- **模块前端资源路由修复**：`app.use('/modules')` 会剥挂载前缀，需再剥一层 `<id>`，否则静态文件 404
- **品牌媒体分析（模块）**：多账号归到一个品牌看整体。品牌总粉丝/总播放/总互动、
  **账号贡献对比**（谁贡献最多 + 占比）、月度趋势、品牌 TOP 视频榜、互动率/平均时长等媒体运营指标。
  分组持久化在模块配置里；未归组的账号会提醒。
  实测（loop.earplugs.offi + loopearplugs.th 归同一品牌，87 条）：
  粉丝 563 的小号贡献了品牌 69.6% 的播放 —— 单账号视角完全看不出来。
- **卖家中心无头化 + 请求记录**：登录成功后自动关窗，之后全程无头（不再弹窗）；
  页面发出的 API 请求会记录到 `/api/seller-import/xhr-log`，为「选日期就自动导出」做准备。
- **登录自动关窗**：有头登录模式检测到 URL 离开 `/account/login` 就自动关窗。
- **模块化架构（P0+P2）**：主程序保持最小，功能做成模块在设置里按需下载。
  - 核心：`lib/settings.js`（设置持久化）、`lib/modules.js`（模块注册表）、`lib/envfile.js`（.env 读写，此前应用根本没加载 .env）
  - 模块以 `.tar.gz` 分发（复用已有 tar 依赖），安装前校验 sha256
  - 依赖**自动级联**开启；停用被依赖的模块会被拦截
  - 第一个模块 **video-download**：单链接 / 批量链接 / 主页 / vid 四种模式
  - 架构文档：`docs/模块化架构.md`

- **更多数据字段（模块 1）**：视频明细从 17 列扩到 20 列，新增
  **转发数、视频ID、挂车**；账号汇总新增**总转发**。
- **挂车 vs 非挂车对比**：新增一个独立工作表（12 项指标：条数 / 总播放 / 平均·中位·最高播放 /
  平均点赞·评论·分享·收藏·转发 / 平均时长 / 互动率），带相对差异列；界面上也有对应区块。
  实测某账号：挂车视频平均播放低 15.8%、中位播放低 30.2%，但最高播放高 82.7%（方差更大）。
  - **改用 `statsV2`**：它比 `stats` 多一个 `repostCount`（转发数），且值是字符串，已统一转数字。
  - **挂车检测**：`isECVideo` 字段直接标记电商视频（实测某账号 60 条里 37 条为真）—— 不需要 Seller Center 授权就能知道哪些视频挂了车。
  - **分辨率修正**：`video.definition` 只是网页播放档位（常年 540p），真实可用最高清晰度取自 `bitrateInfo[].GearName`（形如 `normal_1080`）。
  - 同时抽出但不进表格的字段：`playUrl`（播放地址，供下载功能用）、`qualities`（可下载清晰度档位）、`isAd`、`isAIGC`、`musicOriginal`。
  - `lib/report.js` 新增导出 `pickPlayUrl` / `bestQuality` / `qualityList`，供后续下载功能复用。

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

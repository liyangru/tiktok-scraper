# TikTok 多账号数据抓取服务

输入用户名 → 自动抓取主页视频数据（播放/点赞/评论/分享/收藏/时长/文案/话题标签）→ 导出 Excel。

## 它是怎么工作的

不是爬 HTML，而是**驱动一个真实 Chrome 打开主页，拦截 TikTok 自己发出的 `/api/post/item_list` 响应**，直接拿官方原始 JSON。

### ⚠️ 硬约束（踩过的坑，别改）

| 约束 | 原因 |
|---|---|
| **必须用 Patchright 引擎** | TikTok 拦的是 Playwright 的 CDP 协议指纹。实测：playwright-core 无头被拦（返回空 body），**换成 patchright 后无头/有头都能通**。早期"必须有头"的结论是误判，缺的是引擎不是显示器。 |
| **并发保持 1** | 多会话同时请求时 TikTok 不返回数据（多浏览器/多标签页/多 profile 都试过）。默认 `CONCURRENCY=1`，配合无数据自动重试兜底。 |
| **不能靠"最早视频日期"判断抓完** | 置顶视频日期很老，会立刻误判结束。改用 API 返回的 `cursor` 分页游标判断。 |
| **Docker 里要 `CHROME_NO_SANDBOX=1`** | root 环境下 Chromium 不关沙箱起不来。 |

补充：无头模式（`BROWSER_HEADLESS=1`）实测**可用**，容器部署不需要 xvfb；但如果哪天突然全部返回空数据，优先怀疑被限流（约半天恢复），其次再排查指纹。

---

## 本机运行（Windows）

双击 `start.bat`，或在命令行：

```bash
npm install
node server.js
```

打开 http://127.0.0.1:8899

**端口冲突**：默认 8899。如果被别的项目占了（本机 `free-llm-gateway` 曾占用 8787），服务会**自动往后顺延到 8900、8901…**，以控制台打印的地址为准。想固定就设 `PORT` 环境变量。

**前提**：本机装有 Chrome（自动探测）。装在别处就设 `CHROME_PATH` 环境变量。

抓取时会弹出 Chrome 窗口，**不要关闭它**。

---

## 桌面应用（Electron 版，推荐）

真正的桌面应用：**双击直接开一个独立窗口**——没有命令行黑框、没有浏览器外壳、也没有「Chrome 测试版」提示横幅；**单实例**；**关窗即退出**，可反复打开；导出文件自动落到系统「下载」目录并打开文件夹。

```bash
npm install
npm run app          # 开发运行
npm run build:app    # 打包 → release/TikTokScraper-1.0.0.exe（便携单文件，约 300MB）
```

- 界面用 Electron 自带窗口；**抓取仍用随包内置的 Chromium（无头）**，不依赖系统浏览器、不联网下载。
- 数据与解压出的浏览器在 `%APPDATA%\TikTokScraper`。
- 入口 `electron/main.js`：单实例锁、关窗退出、`no-proxy-server`（避免系统代理拦 loopback）、`disableHardwareAcceleration`（虚拟机/远程桌面更稳）、导出下载落盘。
- 图标由 `scripts/make-icon.js` 用 Chromium 渲染 `public/favicon.svg` 生成 `build/icon.ico`（同时输出 1024px 的 `build/icon.png` 供 macOS 用）。

### macOS 版

**必须在 Mac 上构建。** 两条硬约束，绕不过去：

1. `electron-builder` 从 26 版起**直接拒绝**在 Windows / Linux 上出 macOS 包（报 `Build for macOS is supported only on macOS`）。
2. Apple Silicon 上，**任何未签名（或改了内容导致签名失效）的 app 都起不来**。签名只能用 macOS 自带的 `codesign`。

好在构建脚本会**自动下载**对应架构的浏览器并打包，所以在 Mac 上一条命令就能出包：

```bash
bash scripts/build-mac.sh              # 默认 arm64 + x64
ARCHS="arm64" bash scripts/build-mac.sh   # 只要 Apple Silicon
```

脚本依次做：装依赖 → 生成图标 → 下载 `browser-payload-mac-<arch>.tar.gz`（若本地已有则直接复用）→ `electron-builder --mac zip --<arch>` → 对产物补一次 **ad-hoc 签名**（`codesign --force --deep --sign -`）。产物在 `release-mac/TikTokScraper-1.0.0-<arch>-mac.zip`，**自带浏览器**，不依赖系统 Chrome、不联网下载。

> 载荷约 180–190MB，**超出 GitHub 单文件 100MB 限制，所以不入库**（`.gitignore` 已排除 `*.tar.gz`）。首次构建会下载一次，之后复用本地那份。

分发给别人时提醒对方：首次打开若提示「无法验证开发者」（未做 Apple 公证），右键点 App → 打开，或

```bash
xattr -dr com.apple.quarantine "/Applications/TikTokScraper.app"
```

**关于 macOS 浏览器载荷怎么来的**（`scripts/make-mac-payload.py`）：

macOS 的 `.app` bundle 里 Framework 的 `Versions/Current` 等是**符号链接**，而 Windows 上无法可靠创建符号链接 —— 一旦丢失，app 在 Mac 上直接起不来。所以脚本在 **zip → tar.gz 之间做流式转换**，不落盘、原样保留「符号链接 + 可执行权限位」。两个载荷都是这么产出的（各含 5 个符号链接）。

复现命令（浏览器取自 Google 的 Chrome for Testing，版本与 Windows 版**完全一致**）：

```bash
# 版本 = playwright chromium-1248 = Chrome for Testing 156.0.8078.4
# （注意：patchright 1.63 自带的是 chromium-1243 / Chrome 153，版本对不上，
#   所以载荷统一按 playwright 的版本取；驱动仍用 patchright。）
for A in arm64 x64; do
  curl -L -o "cft-$A.zip" \
    "https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.4/mac-$A/chrome-mac-$A.zip"
  python scripts/make-mac-payload.py "cft-$A.zip" "browser-payload-mac-$A.tar.gz" chromium-1248
done
```

#### 没有 Mac？用 GitHub Actions 出包

仓库里已经放好了 `.github/workflows/build-mac.yml`。把本项目推到一个 GitHub 仓库后：

1. 打开仓库的 **Actions** 页 → 选 **build-mac** → **Run workflow**
2. 跑完在该次运行页面底部 **Artifacts** 下载 `TikTokScraper-mac-arm64` / `TikTokScraper-mac-x64`

工作流在 GitHub 的 macOS 机器上跑（`macos-15` = Apple Silicon，`macos-15-intel` = Intel），自动完成：装依赖 → `patchright install chromium` 取 macOS 版浏览器 → 打包 → **ad-hoc 签名** → 上传产物。Intel 那台机器若在你的账号下不可用，删掉 matrix 里 `x64` 两行即可。

> 若没有自带浏览器（例如没跑打包脚本），程序会自动回退用系统已装的 Chrome / Chromium（`resolveChromePath()` 已内置 macOS 路径）。

---

## 单文件 exe（pkg 版，备选，机器无需装 Node / Chrome）

一个 `tiktok-scraper.exe` 双击就跑。**目标机器不需要装 Node.js，也不需要 Chrome**——Node 运行时和 Chromium 全都打包进 exe 里了。

### 怎么生成

```bash
npm install
npm run build:exe      # 产出 dist/tiktok-scraper.exe（约 280MB）
```

### 怎么用

把 `dist/tiktok-scraper.exe` 单独拷到任意 **Windows x64** 机器，双击即可。首次启动会把内置 Chromium 解压到**同目录的 `tiktok-scraper-data/`**（约 440MB，几秒），之后启动秒开。

- **双击不弹命令行窗口**：exe 已编译成 GUI 子系统（PE `subsystem=2`），没有黑框控制台；日志写到 `tiktok-scraper-data/app.log`。
- **界面开在独立「应用窗口」里**：用**自带** Chromium 的 `--app` 模式，无地址栏、无标签页，**不占用你的默认浏览器**。
- **关闭应用窗口 = 退出程序**（不会在后台残留进程）。
- 抓取本身用**无头**浏览器（不弹抓取窗口）。想看抓取窗口（例如手动过验证码）：设 `BROWSER_HEADLESS=0`。
- 任务记录、浏览器 profile 也都在 `tiktok-scraper-data/` 里，整体可迁移。
- 若 exe 所在目录**不可写**（只读 U 盘 / 受限目录），自动改用 `%LOCALAPPDATA%\TikTokScraper`。
- 想强制指定数据目录：设环境变量 `TT_BASE_DIR`。

### 原理 & 打包踩过的坑

- 用 [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) 把 `bootstrap.js` 打成 node22 单文件；`bootstrap.js` 负责「首次解压浏览器 + 启动 `server.js`」。
- Chromium 以 `browser-payload.tar.gz` 形式内嵌（见 `package.json` 的 `pkg.assets`）。
- **`scripts/patch-pkg.js`（`build:exe` 会自动先跑）** 修两个 pkg 兼容坑：
  1. pkg 的 node 剥离了 `inspector` 绑定，而 playwright 初始化 page 模块时会 `require("inspector")` → 换成无害 stub（仅用于 `page.pause()` 调试，本工具用不到）。
  2. `generator-function` / `async-function` 的 `exports` 指向 `.mjs`，pkg 的 ESM 加载器读不了虚拟快照 → 改成走它们的 CJS 入口。
- 打包必须带 **`--no-bytecode`**：否则 pkg 把 JS 编译成 V8 字节码，`Function.prototype.toString()` 失真，playwright 注入函数时会报 `Passed function is not well-serializable!`（`addInitScript` / `evaluate` 全废）。
- ⚠️ 补丁会改动 `node_modules`，所以**每次 `npm install` 之后都要重新 `npm run build:exe`**（脚本已内置 patch 步骤，直接跑就行）。

### 其它平台

当前只构建了 Windows x64。Mac 需在 Mac 上改 `--targets node22-macos-arm64` 重新构建（Chromium 载荷也要换成 mac 版）。

---

## 发布到 GitHub（一条命令出全平台安装包）

仓库里带了两个工作流，**所有平台的浏览器都在 CI 里现下现打**，所以仓库不需要放大文件（GitHub 单文件上限 100MB，180MB+ 的浏览器载荷本来就进不了仓库）。

| 工作流 | 触发 | 产出 |
|---|---|---|
| `build-mac.yml` | Actions 页手动 | 只要 macOS 包（arm64 / x64），从 Artifacts 下载 |
| `release.yml` | 推 `v*` tag 或手动 | Windows ×2 + macOS ×2 + 部署包，**自动发 Release** |

推代码 / 出包一条命令：

```bash
gh auth login                                    # 或用 GITHUB_TOKEN=xxx
bash scripts/publish-github.sh <owner>/<repo>            # 只推代码
bash scripts/publish-github.sh <owner>/<repo> v1.0.0     # 推代码 + 打 tag → 出全平台包并发 Release
```

脚本会：仓库不存在就建（默认 private，可用 `VISIBILITY=public` 改）→ 推送（token 走一次性 URL，**不写进 `.git/config`**）→ 打 tag 触发构建。

Release 里的产物：

| 文件 | 说明 |
|---|---|
| `TikTokScraper-<版本>.exe` | Windows Electron 便携版（推荐） |
| `tiktok-scraper.exe` | Windows pkg 单文件便携版（备选） |
| `TikTokScraper-<版本>-arm64-mac.zip` | macOS Apple Silicon |
| `TikTokScraper-<版本>-x64-mac.zip` | macOS Intel |
| `tiktok-scraper-server-<版本>.tar.gz` | 本地 / 服务器部署包（源码 + `start.sh`，需 Node 18+） |

---

## 部署到腾讯云服务器（推荐）

### ⚠️ 第一件事：必须选海外节点

**中国内地节点无法访问 TikTok，部署完就是摆设。** 买机器时地域必须选：

- ✅ 中国香港 / 新加坡 / 曼谷 / 硅谷
- ❌ 北京 / 上海 / 广州 / 成都（TikTok 不可达）

轻量应用服务器（Lighthouse）或 CVM 都行。配置建议 **2 核 2G 起步**（Chromium 吃内存）。

### 三步部署

**① 本地打包**（在项目目录）

```bash
bash pack.sh          # 生成 tiktok-scraper.tar.gz
```

**② 上传到服务器**

```bash
scp tiktok-scraper.tar.gz root@<服务器IP>:/root/
```

**③ 服务器上一键装好并启动**

```bash
mkdir -p /root/tiktok-scraper && tar -xzf /root/tiktok-scraper.tar.gz -C /root/tiktok-scraper
cd /root/tiktok-scraper && bash tencent-setup.sh
```

脚本会自动：装 Docker → 生成访问口令 → 构建镜像 → 启动 → 打印带口令的访问地址。

**④ 放行端口**

去**腾讯云控制台 → 防火墙 / 安全组**，放行 TCP `8899`。这一步不做，外网访问不了。

### 资源估算

- 每个 Chrome 进程 ≈ 300-400MB 内存
- 2GB 内存可以跑（并发 1）
- 单账号抓取 20-90 秒（取决于视频数量）

### 安全

- **已内置访问口令**（`ACCESS_TOKEN`）。`tencent-setup.sh` 会自动生成一个随机口令。
- 首次访问用 `http://<IP>:8899/?token=<口令>`，之后种 cookie，直接开根路径就行。
- 想换口令：改 `.env` 里的 `ACCESS_TOKEN` 然后 `docker compose up -d`。
- 有域名的话建议再套一层 Caddy 自动 HTTPS（口令走 HTTP 明文传输有风险）。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8899` | 监听端口。**被占用会自动往后顺延**（8900、8901…），以控制台打印为准 |
| `HOST` | `127.0.0.1` | 监听地址，Docker 里设 `0.0.0.0` |
| `ACCESS_TOKEN` | 空 | 访问口令。**留空 = 不鉴权，只适合本机用**；公网必须设 |
| `CONCURRENCY` | `1` | 并发数。**实测 >1 不可靠**，建议保持 1 |
| `MAX_SCROLLS` | `400` | 单账号最大滚动次数，防止死循环 |
| `CHROME_PATH` | 自动探测 | Chrome/Chromium 可执行文件路径 |
| `CHROME_NO_SANDBOX` | `0` | Docker/root 环境必须设 `1`，否则 Chromium 起不来 |
| `BROWSER_HEADLESS` | `0` | 无头开关。Patchright 下无头可用（容器靠它免 xvfb）；本机默认有头，方便看浏览器窗口 |
| `SCRAPER_DEBUG` | `0` | 设 `1` 输出页面诊断日志 |

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查，返回检测到的浏览器路径 |
| `POST` | `/api/scrape` | 提交任务 `{handles, from, to, concurrency}` |
| `GET` | `/api/jobs/:id` | 查询进度与结果 |
| `GET` | `/api/jobs/:id/export.xlsx` | 下载 Excel |
| `GET` | `/api/jobs/:id/export.csv` | 下载 CSV |
| `GET` | `/api/jobs` | 历史任务列表 |
| `DELETE` | `/api/jobs/:id` | 删除任务 |

`handles` 支持换行、逗号、空格分隔，也支持直接粘贴主页链接。

---

## 已知限制

- **抓不到私密/已删除视频**，只能拿公开数据。
- **评论区数据拿不到**，只有评论数。
- **播放量是 TikTok 的公开口径**，非后台真实数据，会有偏差。
- **频繁抓取可能触发风控**，建议并发不超过 3，账号多时分批。
- 任务状态存在内存 + `data/jobs/*.json`，服务重启后历史任务仍可查看，但**运行中的任务会丢失**。

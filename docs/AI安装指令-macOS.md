# TikTokScraper v2.0.1 · macOS 安装指令（复制整段给 AI 执行）

你现在要在 Mac 上帮我安装 TikTokScraper v2.0.1 极简分析版。严格按下面的步骤执行，每步给出实际命令和输出，失败就贴原始报错并停止，不要猜测。

## 环境前提
- 芯片判断：先确认是 Apple Silicon（M 系列）还是 Intel，两者包不同
- 版本：v2.0.1（2026-11-17）
- 最低系统：macOS 13.0（Ventura）及以上
- 官方仓库：https://github.com/liyangru/tiktok-scraper
- arm64 包（M 系列）：https://github.com/liyangru/tiktok-scraper/releases/download/v2.0.1/TikTokScraper-2.0.1-arm64-mac.zip
- x64 包（Intel）：https://github.com/liyangru/tiktok-scraper/releases/download/v2.0.1/TikTokScraper-2.0.1-x64-mac.zip

## 步骤

### 1. 判断芯片架构
```bash
uname -m
```
- 输出 `arm64` → 用 arm64 包（第 2A 步）
- 输出 `x86_64` → 用 x64 包（第 2B 步）

### 2A. 下载 arm64 包（M 系列）
```bash
mkdir -p ~/Downloads/TikTokScraper-install && cd ~/Downloads/TikTokScraper-install
curl -L -o TikTokScraper-2.0.1-arm64-mac.zip \
  "https://github.com/liyangru/tiktok-scraper/releases/download/v2.0.1/TikTokScraper-2.0.1-arm64-mac.zip"
ls -lh TikTokScraper-2.0.1-arm64-mac.zip
```
判定：约 129 MB。

### 2B. 下载 x64 包（Intel）
```bash
mkdir -p ~/Downloads/TikTokScraper-install && cd ~/Downloads/TikTokScraper-install
curl -L -o TikTokScraper-2.0.1-x64-mac.zip \
  "https://github.com/liyangru/tiktok-scraper/releases/download/v2.0.1/TikTokScraper-2.0.1-x64-mac.zip"
ls -lh TikTokScraper-2.0.1-x64-mac.zip
```
判定：约 133 MB。

### 3. 解压
arm64：
```bash
unzip -o TikTokScraper-2.0.1-arm64-mac.zip
```
x64：
```bash
unzip -o TikTokScraper-2.0.1-x64-mac.zip
```
判定：得到 `TikTokScraper.app`。

### 4. 校验架构（确认下对包，尤其 M 芯片）
```bash
file TikTokScraper.app/Contents/MacOS/TikTokScraper
```
- M 芯片应为 `Mach-O 64-bit executable arm64`
- Intel 应为 `Mach-O 64-bit executable x86_64`
若架构与第 1 步芯片不符，删掉重新下对应包。

### 5. 校验版本
```bash
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
  TikTokScraper.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" \
  TikTokScraper.app/Contents/Info.plist
```
判定：版本 `2.0.1`，最低系统 `13.0`。

### 6. 去掉隔离属性并 ad-hoc 重签名（关键，否则打不开）
包在 CI 里已做 ad-hoc 签名，但下载带 quarantine，需清除：
```bash
xattr -dr com.apple.quarantine TikTokScraper.app
codesign --force --deep --sign - TikTokScraper.app
codesign --verify --deep --strict TikTokScraper.app && echo "SIGN_OK"
```
判定：输出 `SIGN_OK`。

### 7. 安装到「应用程序」
```bash
rm -rf /Applications/TikTokScraper.app
mv TikTokScraper.app /Applications/
ls -ld /Applications/TikTokScraper.app
```

### 8. 启动验证
```bash
open -a TikTokScraper
sleep 5
pgrep -fl TikTokScraper
```
判定：有进程输出即启动成功。

### 9. 完成标准
- 芯片与包架构一致（M→arm64，Intel→x64）
- 版本 2.0.1，最低系统 13.0
- 签名校验 SIGN_OK
- 已装入 /Applications 并能启动
- 应用显示「本地数据模式 · 无浏览器」

如实汇报每步实际输出。任何一步不达标就停下并贴出原始报错。

## 备注：首次打开提示「无法验证开发者」时
GUI 操作：在 Finder 里右键 `TikTokScraper.app` → 打开 → 弹窗里再点「打开」。
或命令行：
```bash
xattr -dr com.apple.quarantine /Applications/TikTokScraper.app
```
这是 ad-hoc 签名（未做 Apple 公证）的预期行为，不影响功能。

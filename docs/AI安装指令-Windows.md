# TikTokScraper v2.0.1 · Windows 安装指令（复制整段给 AI 执行）

你现在要在 Windows 机器上帮我安装 TikTokScraper v2.0.1 极简分析版。严格按下面的步骤执行，每步都要给出实际命令和输出，遇到失败原样报错并停止，不要猜测结果。

## 环境前提
- 目标机器：Windows 10/11 x64
- 版本：v2.0.1（发布日期 2026-11-17）
- 官方仓库：https://github.com/liyangru/tiktok-scraper
- 安装包直链：https://github.com/liyangru/tiktok-scraper/releases/download/v2.0.1/TikTokScraper-2.0.1-setup.exe

## 步骤

### 1. 下载安装包
用 PowerShell 下载到临时目录（不要用浏览器，直接命令行）：

```powershell
$dir = "$env:TEMP\TikTokScraper-install"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$setup = Join-Path $dir "TikTokScraper-2.0.1-setup.exe"
Invoke-WebRequest -UseBasicParsing `
  -Uri "https://github.com/liyangru/tiktok-scraper/releases/download/v2.0.1/TikTokScraper-2.0.1-setup.exe" `
  -OutFile $setup
"sizeMB=" + [math]::Round((Get-Item $setup).Length/1MB,1)
```
判定：文件大小应约 98.2 MB。明显偏小（比如几 KB）说明下载的是错误页，停止。

### 2. 检查是否已在运行，避免文件占用
```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'TikTokScraper' } |
  Select-Object ProcessId,Name,ExecutablePath
```
如有输出，先 `Stop-Process -Id <PID> -Force` 结束它们。

### 3. 静默安装（NSIS /S）
```powershell
$p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait
"exit=" + $p.ExitCode
```
判定：exit 必须为 0。

### 4. 验证安装结果
```powershell
$installDir = "$env:LOCALAPPDATA\Programs\TikTokScraper"
# NSIS perMachine=false + 默认路径也可能装到用户目录，两条路径都查
$candidates = @($installDir, "D:\XIAZAI\浏览器\TikTokScraper", "$env:ProgramFiles\TikTokScraper")
foreach ($c in $candidates) {
  if (Test-Path -LiteralPath (Join-Path $c "TikTokScraper.exe")) {
    $vi = (Get-Item (Join-Path $c "TikTokScraper.exe")).VersionInfo
    "FOUND: $c  version=$($vi.ProductVersion)"
  }
}
Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'TikTokScraper' } |
  Select-Object DisplayName,DisplayVersion,UninstallString
```
判定：ProductVersion 必须是 `2.0.1`，注册表 DisplayVersion 必须是 `2.0.1`。

### 5. 清理 2.0 不需要的旧浏览器载荷（如果从 1.x 升级会残留）
```powershell
$payload = "<安装目录>\resources\browser-payload.tar.gz"
if (Test-Path -LiteralPath $payload) {
  Remove-Item -LiteralPath $payload -Force
  "removed stale browser payload"
}
```
（`<安装目录>` 用第 4 步查到的实际路径替换。）

### 6. 冒烟启动验证
```powershell
$exe = "<安装目录>\TikTokScraper.exe"
$proc = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 8
Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq $proc.Id } |
  Select-Object ProcessId,Name
```
判定：进程持续存在即启动成功。应用日志在 `%APPDATA%\TikTokScraper\crash.log`，如启动异常读它。

### 7. 完成标准
- 安装包下载约 98 MB
- 静默安装 exit=0
- exe 与注册表版本均为 2.0.1
- 应用能启动且窗口出现「本地数据模式 · 无浏览器」
- 已清理残留 browser-payload.tar.gz

如实汇报每一步的实际输出。任何一步不达标就停下并贴出原始报错。

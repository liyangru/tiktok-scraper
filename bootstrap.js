/**
 * 单文件 exe 启动引导（pkg 入口）
 * ------------------------------------------------------------------
 * 普通运行（node server.js）不受影响；只有被 pkg 打成 exe 后，本文件才是入口。
 *
 * 职责：
 *   1. 计算「可写基目录」，注入环境变量 TT_BASE_DIR
 *      —— 因为 pkg 快照里的 __dirname 是只读的，data/ 必须落到可写盘。
 *   2. 首次运行：把内嵌的 browser-payload.tar.gz（Chromium）解压到可写目录，
 *      并设置 PLAYWRIGHT_BROWSERS_PATH，让 patchright 找到浏览器。
 *   3. require('./server.js') 启动服务。
 *
 * 目录优先级（可写基目录）：
 *   TT_BASE_DIR（显式指定）> exe 同目录 tiktok-scraper-data（便携）> %LOCALAPPDATA%\TikTokScraper
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const isPkg = typeof process.pkg !== 'undefined';
const EXE_DIR = isPkg ? path.dirname(process.execPath) : __dirname;

function log(...a) {
  console.log('[bootstrap]', ...a);
}

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/** 计算可写基目录 */
function resolveBaseDir() {
  if (process.env.TT_BASE_DIR) return process.env.TT_BASE_DIR;
  if (!isPkg) return __dirname; // 普通运行：项目目录本身
  // 便携优先：exe 同目录可写就用它（拷到 U 盘也能用）
  const portable = path.join(EXE_DIR, 'tiktok-scraper-data');
  if (isWritable(portable)) return portable;
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(la, 'TikTokScraper');
}

const BASE_DIR = resolveBaseDir();
process.env.TT_BASE_DIR = BASE_DIR;
fs.mkdirSync(BASE_DIR, { recursive: true });

// GUI 模式（exe 已改为无控制台子系统）下 stdout 可能不可用：日志同时落盘，控制台写入包 try/catch 防崩
const LOG_FILE = path.join(BASE_DIR, 'app.log');
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _fmt = (a) =>
  a
    .map((x) => {
      if (typeof x === 'string') return x;
      try { return JSON.stringify(x); } catch (_) { return String(x); }
    })
    .join(' ');
console.log = (...a) => {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${_fmt(a)}\n`); } catch (_) {}
  try { _origLog(...a); } catch (_) {}
};
console.error = (...a) => {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ERR ${_fmt(a)}\n`); } catch (_) {}
  try { _origErr(...a); } catch (_) {}
};

const { ensureBrowsers } = require('./lib/browsers');

if (isPkg) {
  try {
    // 只用「自带」的浏览器：不依赖、不回退系统 Chrome，也不联网下载
    ensureBrowsers(BASE_DIR, [path.join(__dirname, 'browser-payload.tar.gz')]);
  } catch (e) {
    log('解压 Chromium 失败:', e && e.message);
  }
}

// 抓取用「无头」浏览器（不弹抓取窗口；Patchright 无头已实测可用）。
// 界面另开一个独立「应用窗口」：自带 Chromium 的 --app 模式（见 server.js openBrowser）。
// 想看到抓取用的浏览器窗口（例如要手动过验证码）：设 BROWSER_HEADLESS=0
if (isPkg && process.env.BROWSER_HEADLESS === undefined) {
  process.env.BROWSER_HEADLESS = '1';
}

log('数据目录:', BASE_DIR);
log('内置浏览器:', process.env.CHROME_PATH || process.env.PLAYWRIGHT_BROWSERS_PATH || '(未设置)');

// exe 启动时：将内嵌模块包预装到用户本地数据目录。先预装再 require server，
// 否则 loadEnabled 看不到模块；源码运行（node server.js）不走此流程。
async function preloadBundledModules() {  if (!isPkg) return;
  const snapDir = path.join(__dirname, 'modules-dist'); // pkg assets 虚拟快照
  if (!fs.existsSync(snapDir)) {
    log('未找到内置模块包:', snapDir);
    return;
  }
  const modDir = path.join(BASE_DIR, 'modules');
  fs.mkdirSync(modDir, { recursive: true });
  const tar = require('tar');
  let entries = [];
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(snapDir, 'index.json'), 'utf8'));
    entries = idx.modules || [];
  } catch (e) {
    log('内置模块索引读取失败:', e.message);
    return;
  }
  for (const entry of entries) {
    const id = entry.id;
    const archive = path.join(snapDir, `${id}-${entry.version}.tar.gz`);
    if (!id || !fs.existsSync(archive)) continue;
    // 总是用 exe 内置的版本覆盖（自愈：修复本地缺文件/半装的模块）。
    // 用户自己的 settings.json 开关不受影响（那只记录 enabled/config）。
    try { fs.rmSync(path.join(modDir, id), { recursive: true, force: true }); } catch (_) {}
    try {
      await tar.x({ file: archive, cwd: modDir });
      log('预装模块:', id);
    } catch (e) {
      log('预装模块失败:', id, e.message);
    }
  }
  const idx = path.join(snapDir, 'index.json');
  if (fs.existsSync(idx)) {
    try { fs.copyFileSync(idx, path.join(BASE_DIR, 'modules-dist-index.json')); } catch (_) {}
  }
}

/**
 * 干掉占用我们 ui-profile 的残留 Chromium。
 * 不清理的话：新 spawn 会把 URL「转发」给已在跑的旧 Chromium 然后自己退出 →
 * 看起来就是「双击没反应 / 窗口不出现」。这是 Chromium 的 profile 单例行为。
 */
function killStaleUiBrowsers() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('wmic', ['process', 'where', "name='chrome.exe'", 'get', 'ProcessId,CommandLine', '/format:csv'], {
      encoding: 'utf8', windowsHide: true, timeout: 8000,
    });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('ui-profile')) continue;
      const m = /(\d+)\s*$/.exec(line.trim());
      if (m) {
        try {
          execFileSync('taskkill', ['/F', '/PID', m[1]], { windowsHide: true, stdio: 'ignore' });
          log('清理占用界面的残留浏览器 PID', m[1]);
        } catch (_) {}
      }
    }
  } catch (_) {} // wmic 不可用就算了，不影响主流程
}

/** 打开应用窗口（自带 Chromium --app 模式；失败静默） */
function openAppWindow(url) {
  try {
    killStaleUiBrowsers();
    const { spawn } = require('child_process');
    const exe = process.env.CHROME_PATH || path.join(BASE_DIR, 'browsers', 'chromium-1248', 'chrome-win64', 'chrome.exe');
    if (!fs.existsSync(exe)) return false;
    const profile = path.join(BASE_DIR, 'ui-profile');
    fs.mkdirSync(profile, { recursive: true });
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.rmSync(path.join(profile, f), { force: true }); } catch (_) {}
    }
    const child = spawn(exe, [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=ChromeForTestingBanner,Translate,AcceptCHFrame,MediaRouter',
      '--test-type', // 抑制 Chrome for Testing 的「仅适用于自动测试」提示条
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--window-size=1440,960',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 启动流程：
//   0) 单实例守卫：目标端口上如果已有本应用在跑 → 直接开它的窗口并退出本进程
//   1) 加载页用「临时端口」（绝不和主服务抢端口），浏览器窗口立即打开加载页
//   2) 每个阶段更新进度；主服务就绪后把真实端口告诉加载页，页面自动跳转
//   3) 失败：加载页常驻显示原因与日志路径，进程不退出
(async () => {
  const APP_PORT = parseInt(process.env.PORT || "8899", 10); // 主服务用的端口（加载页绝不占用它）
  let splash = null;

  // ---- 单实例守卫 ----
  try {
    const probe = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (probe.ok) {
      const j = await probe.json().catch(() => ({}));
      const ver = require('./package.json').version;
      if (j.version === ver) {
        log('已有实例在运行（同版本），直接打开它的窗口');
        openAppWindow(`http://127.0.0.1:${APP_PORT}/`);
        process.exit(0);
      }
      // 端口上是个旧版本：提示用户先关掉，同时把旧窗口打开方便其关闭
      const msg = `检测到旧版本仍在运行（端口 ${APP_PORT}）。\n请先关闭旧的 TikTok 数据抓取窗口，再重新启动本程序。`;
      log('⚠ ' + msg);
      openAppWindow(`http://127.0.0.1:${APP_PORT}/`);
      // 用加载页把这句话显示出来（它不占目标端口，随时可用）
      const { createSplash } = require('./lib/splash');
      const s2 = await createSplash();
      s2.fail(msg.replace(/\\n/g, ' '), LOG_FILE);
      openAppWindow(`http://127.0.0.1:${s2.port}/`);
      setTimeout(() => process.exit(0), 600000); // 给足时间看提示
      return;
    }
  } catch (_) {} // 探测失败 = 端口没人听，正常往下走

  try {
    const { createSplash } = require('./lib/splash');
    splash = await createSplash(); // 临时端口，不占目标端口
    log('加载页:', `http://127.0.0.1:${splash.port}/`);
    if (process.env.NO_AUTO_OPEN !== '1') {
      const ok = openAppWindow(`http://127.0.0.1:${splash.port}/`);
      log(ok ? '已打开加载窗口' : '⚠ 未能打开窗口（找不到内置 Chromium？）');
    }

    splash.set('解压内置浏览器…');
    if (isPkg) {
      try {
        ensureBrowsers(BASE_DIR, [path.join(__dirname, 'browser-payload.tar.gz')]);
      } catch (e) {
        throw new Error('解压 Chromium 失败: ' + (e && e.message));
      }
    }

    splash.set('预装功能模块…');
    await preloadBundledModules();

    splash.set('启动主服务…');
    process.env.NO_AUTO_OPEN = '1'; // 窗口已打开，主服务别再开第二个
    const { start } = await Promise.resolve(require('./server.js'));
    const realPort = await start(APP_PORT); // 主服务端口若被占会自动顺延
    splash.ready(realPort); // 告诉加载页真实地址，页面自己跳转
    // ⚠️ 加载页**不关闭**：窗口冷启动要 2~4 秒，早关会让页面永远问不到地址（之前就是这个 bug）。
    //    它只占一个临时端口，留着零成本，反而让刷新页面也能重新拿到地址。
    log('就绪: http://127.0.0.1:' + realPort);
  } catch (e) {
    const msg = e && e.stack ? e.stack : String(e && e.message);
    console.error('启动失败:', msg);
    if (splash) {
      splash.fail(msg, LOG_FILE); // 加载页显示原因与日志路径，进程保持存活
    } else {
      process.exit(1);
    }
  }
})();

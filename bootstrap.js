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
    const manifest = path.join(modDir, id, 'module.json');
    if (!id || !fs.existsSync(archive) || fs.existsSync(manifest)) continue; // 不覆盖用户状态
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

// 启动流程：先起「加载页」占住端口 → 预装/解压每一步更新进度 → 主服务就绪后
// splash 关闭、主服务在同一端口接管，浏览器页面自动跳进主界面；失败则页面显示原因。
(async () => {
  let PORT = parseInt(process.env.PORT || "8899", 10);
  let splash = null;
  try {
    const { createSplash } = require('./lib/splash');
    splash = await createSplash(PORT);
    PORT = splash.port; // 目标端口被占时 splash 会顺延，后续全部用它
    // 尽早打开窗口显示加载页（spawn 自带 Chromium 的 --app 模式，静默失败无妨）
    try {
      const { spawn } = require('child_process');
      const exe = process.env.CHROME_PATH || path.join(BASE_DIR, 'browsers', 'chromium-1248', 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) {
        const profile = path.join(BASE_DIR, 'ui-profile');
        fs.mkdirSync(profile, { recursive: true });
        const child = spawn(exe, [
          `--app=http://127.0.0.1:${PORT}/`,
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-features=ChromeForTestingBanner',
          '--window-size=1440,960',
        ], { detached: true, stdio: 'ignore' });
        child.unref();
      }
    } catch (_) {}

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
    process.env.NO_AUTO_OPEN = '1'; // 窗口已在加载页阶段打开，主服务别再开第二个
    const { start } = await Promise.resolve(require('./server.js'));
    const realPort = await start(PORT); // splash 已占住此端口，主服务直接接管
    await splash.close(); // 主服务已在同一端口接管
    log('就绪: http://127.0.0.1:' + realPort);
  } catch (e) {
    const msg = e && e.stack ? e.stack : String(e && e.message);
    console.error('启动失败:', msg);
    if (splash) {
      splash.fail(msg, LOG_FILE); // 加载页会显示原因与日志路径，进程保持存活让用户看到
    } else {
      process.exit(1);
    }
  }
})();

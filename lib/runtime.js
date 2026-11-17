/**
 * 不开桌面应用时的运行时（命令行 / MCP 插件共用）
 *
 * - 数据目录：优先复用桌面应用的数据目录（历史任务、视频库、浏览器都共用），没装应用就用 ~/.tiktok-scraper
 * - 浏览器：桌面应用已解压的 Chromium → CHROME_PATH → Patchright 自己下载的 Chromium；都没有就提示 setup
 * - 抓取档案：单独用 data/profiles-agent，避免和正在运行的桌面应用抢同一个浏览器档案
 * - 依赖：插件安装后首次使用时自动 npm install（不含 Electron 等开发依赖）
 *
 * ⚠️ 这个文件本身只用 Node 内置模块：MCP 服务必须在依赖还没装好时也能启动并回应。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP_NAMES = ['TikTokScraper', 'tiktok-scraper'];

/** 桌面应用的数据目录候选（Electron app.getPath('userData')） */
function appDataCandidates() {
  const home = os.homedir();
  const bases =
    process.platform === 'win32'
      ? [process.env.APPDATA || path.join(home, 'AppData', 'Roaming')]
      : process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support')]
      : [process.env.XDG_CONFIG_HOME || path.join(home, '.config')];
  return bases.flatMap((b) => APP_NAMES.map((n) => path.join(b, n)));
}

function resolveBaseDir() {
  if (process.env.TT_BASE_DIR) return { dir: process.env.TT_BASE_DIR, shared: false, source: 'env' };
  for (const d of appDataCandidates()) {
    if (fs.existsSync(path.join(d, 'data', 'jobs')) || fs.existsSync(path.join(d, 'browsers'))) return { dir: d, shared: true, source: 'app' };
  }
  return { dir: path.join(os.homedir(), '.tiktok-scraper'), shared: false, source: 'home' };
}

const BASE = resolveBaseDir();
// 必须在 require 任何核心库之前设好：videodb / settings / scraper 在加载时读这些环境变量
process.env.TT_BASE_DIR = BASE.dir;
process.env.PROFILE_DIR = process.env.PROFILE_DIR || path.join(BASE.dir, 'data', 'profiles-agent');
if (process.env.BROWSER_HEADLESS === undefined) process.env.BROWSER_HEADLESS = '1'; // 插件 / 命令行默认无头
fs.mkdirSync(path.join(BASE.dir, 'data', 'jobs'), { recursive: true });

function depsReady() {
  try {
    require.resolve('patchright', { paths: [ROOT] });
    require.resolve('exceljs', { paths: [ROOT] });
    return true;
  } catch (_) {
    return false;
  }
}

/** 运行一条命令，输出转到 stderr（MCP 的 stdout 只能走协议消息） */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', ...opts });
    let tail = '';
    const onData = (d) => {
      tail = (tail + d.toString()).slice(-2000);
      if (opts.echo) process.stderr.write(d);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(tail) : reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}\n${tail.slice(-600)}`))));
  });
}

let installing = null;
/** 安装运行依赖（不含 Electron / electron-builder 等开发依赖，也不跑安装脚本，不会下载 Electron） */
function installDeps(echo) {
  if (depsReady()) return Promise.resolve('ready');
  if (!installing) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    installing = run(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { echo })
      .then(() => 'installed')
      .finally(() => {
        installing = null;
      });
  }
  return installing;
}
const isInstalling = () => !!installing;

/** 找可用的 Chromium；找到就写进 CHROME_PATH 给 scraper 用 */
function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const dirs = [path.join(BASE.dir, 'browsers'), ...appDataCandidates().map((d) => path.join(d, 'browsers'))];
  try {
    const { findChromium } = require('./browsers');
    for (const d of dirs) {
      const exe = findChromium(d);
      if (exe) {
        process.env.CHROME_PATH = exe;
        return exe;
      }
    }
  } catch (_) {}
  if (depsReady()) {
    try {
      const exe = require(require.resolve('patchright', { paths: [ROOT] })).chromium.executablePath();
      if (exe && fs.existsSync(exe)) return exe;
    } catch (_) {}
  }
  return null;
}

let browserInstalling = null;
/** 下载 Patchright 对应版本的 Chromium（约 170MB，只需一次） */
function installBrowser(echo) {
  if (findBrowser()) return Promise.resolve('ready');
  if (!browserInstalling) {
    browserInstalling = run(process.execPath, [path.join(ROOT, 'node_modules', 'patchright', 'cli.js'), 'install', 'chromium'], { echo, shell: false })
      .then(() => 'installed')
      .finally(() => {
        browserInstalling = null;
      });
  }
  return browserInstalling;
}
const isBrowserInstalling = () => !!browserInstalling;

let store = null;
/** 任务库（首次调用时才加载核心依赖） */
function getStore() {
  if (store) return store;
  if (!depsReady()) throw new Error('DEPS_MISSING');
  findBrowser();
  const { createJobStore } = require('./jobs');
  store = createJobStore({
    dataDir: path.join(BASE.dir, 'data', 'jobs'),
    scraper: require('./scraper'),
    report: require('./report'),
    videodb: require('./videodb'),
    maxScrolls: parseInt(process.env.MAX_SCROLLS || '400', 10),
    log: (m) => process.stderr.write(`[tiktok-scraper] ${m}\n`),
  });
  return store;
}

function doctor() {
  return {
    version: require('../package.json').version,
    node: process.version,
    dataDir: BASE.dir,
    sharedWithDesktopApp: BASE.shared,
    depsReady: depsReady(),
    installingDeps: isInstalling(),
    browser: findBrowser(),
    installingBrowser: isBrowserInstalling(),
    headless: process.env.BROWSER_HEADLESS === '1',
  };
}

module.exports = { ROOT, BASE, depsReady, installDeps, isInstalling, findBrowser, installBrowser, isBrowserInstalling, getStore, doctor };

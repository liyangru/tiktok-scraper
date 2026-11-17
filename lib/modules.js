/**
 * 模块系统：扫描 / 下载安装 / 卸载 / 启停（含依赖级联）/ 加载
 *
 * 分发格式：**.tar.gz**（不是 zip）—— 复用已有 tar 依赖，不引新包，且能保住执行权限位。
 * 安装目录：<BASE_DIR>/modules/<id>/
 * 远端索引：仓库里的 modules/index.json（含每个包的大小与 sha256，装前校验）
 *
 * ⚠️ 安全边界（必须如实告知用户）：
 *    模块在**主进程内**运行，不是沙箱 —— 模块代码拥有主程序的全部权限。
 *    所以只从本仓库安装，界面上也要把这句话写出来。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable, PassThrough } = require('stream');
const tar = require('tar');

const settings = require('./settings');

const BASE_DIR = settings.BASE_DIR;
const MODULES_DIR = path.join(BASE_DIR, 'modules');

/** 远端索引地址（可被 settings.core.indexUrl 覆盖，方便自建/离线） */
const DEFAULT_INDEX_URL =
  'https://raw.githubusercontent.com/liyangru/tiktok-scraper/master/modules/index.json';

/**
 * 索引地址优先级：
 *   1) settings.core.indexUrl（用户显式指定）
 *   2) <BASE_DIR>/modules-dist/index.json（Electron 打包后：extraResources 解出来的）
 *   3) <项目>/modules-dist/index.json（开发态：scripts/build-modules.js --local 生成）
 *   4) 远端 GitHub 索引
 * ⚠️ 之前只认 settings 里的 indexUrl，而它可能指向一个已经不存在的旧工作区路径 ——
 *    结果就是「设置里一个模块都看不到」。现在先找本地，本地没有才走远端。
 */
function resolveIndexUrl() {
  const explicit = settings.getCore().indexUrl;
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  const candidates = [
    path.join(BASE_DIR, 'modules-dist', 'index.json'),
    // Electron 打包态：extraResources 解出来的位置（进程内 __dirname 在 asar 里，找不到）
    process.resourcesPath ? path.join(process.resourcesPath, 'modules-dist', 'index.json') : null,
    path.join(__dirname, '..', 'modules-dist', 'index.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return DEFAULT_INDEX_URL;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function dirOf(id) {
  return path.join(MODULES_DIR, id);
}

/* ---------------- 本地扫描 ---------------- */

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8'));
    if (!m || !m.id) return null;
    return m;
  } catch (_) {
    return null;
  }
}

/** 已安装模块的清单列表 */
function listInstalled() {
  if (!fs.existsSync(MODULES_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(MODULES_DIR)) {
    const dir = dirOf(name);
    let st;
    try {
      st = fs.statSync(dir);
    } catch (_) {
      continue;
    }
    if (!st.isDirectory()) continue;
    const man = readManifest(dir);
    if (man) out.push({ ...man, installed: true });
  }
  return out;
}

/* ---------------- 远端索引 ---------------- */

async function fetchIndex() {
  const url = resolveIndexUrl();
  // 本地路径（开发态 / 打包态）：直接读文件，省得为测试起 HTTP 服务
  if (!/^https?:/i.test(url)) {
    const file = url.startsWith('file://') ? url.replace(/^file:\/\//, '') : url;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(json.modules) ? json.modules : [];
    // 打包态索引里 url 是相对文件名（seller-import-1.3.0.tar.gz），
    // 这里按索引所在目录解析成绝对路径，否则 download() 会当成本地不存在而失败。
    const base = path.dirname(file);
    return list.map((m) => {
      if (m && typeof m.url === 'string' && !/^([a-z]+:|\/)/i.test(m.url)) {
        return { ...m, url: path.join(base, m.url) };
      }
      return m;
    });
  }
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`拉取模块索引失败：HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json.modules) ? json.modules : [];
}

/* ---------------- 安装 ---------------- */

/** 下载进度表：id → { stage, pct }。前端在 POST install 飞行期间轮询它 */
const progressMap = new Map();
function getProgress(id) {
  return progressMap.get(id) || null;
}

async function download(url, dest, onProgress = () => {}) {
  // 本地包（开发态 / 打包进安装包的 modules-dist）
  if (!/^https?:/i.test(url)) {
    const file = url.startsWith('file://') ? url.replace(/^file:\/\//, '') : url;
    const total = fs.statSync(file).size;
    const hash = crypto.createHash('sha256');
    let done = 0;
    const counter = new PassThrough();
    counter.on('data', (c) => {
      hash.update(c);
      done += c.length;
      if (total) onProgress(Math.min(99, Math.round((done / total) * 100)));
    });
    await pipeline(fs.createReadStream(file), counter, fs.createWriteStream(dest));
    onProgress(100);
    return hash.digest('hex');
  }
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const hash = crypto.createHash('sha256');
  let done = 0;
  const counter = new PassThrough();
  counter.on('data', (c) => {
    hash.update(c);
    done += c.length;
    if (total) onProgress(Math.min(99, Math.round((done / total) * 100)));
  });
  const body = Readable.fromWeb(res.body);
  await pipeline(body, counter, fs.createWriteStream(dest));
  onProgress(100);
  return hash.digest('hex');
}

/**
 * 安装模块。步骤：下载 → 校验 sha256 → 解到临时目录 → 校验清单 → 原子替换。
 * 任何一步失败都不留半成品。
 */
async function install(entry, onLog = () => {}) {
  const { id, url, sha256, version } = entry;
  if (!id || !url) throw new Error('索引条目缺少 id 或 url');
  ensureDir(MODULES_DIR);

  // ⚠️ 临时目录必须建在 BASE_DIR 下，不能 os.tmpdir()：
  //    tmpdir 可能在另一块盘（如 D:\Temp vs C:\Users\...），
  //    最后一步 fs.renameSync 跨设备会直接 EXDEV 失败（真实踩过）。
  //    BASE_DIR 内建 .tmp 保证与目标 modules/ 同卷，rename 才原子可用。
  const tmpDir = fs.mkdtempSync(path.join(ensureDir(path.join(BASE_DIR, '.tmp')), `ttmod-${id}-`));
  const pkg = path.join(tmpDir, 'pkg.tar.gz');
  const stage = ensureDir(path.join(tmpDir, 'stage'));

  /* 下载进度：前端轮询 /api/modules/:id/install-progress。
     阶段故意分三步（下载 → 校验 → 安装），这样哪怕包很小、下载一瞬间完成，
     用户也能看到「这是一次完整的下载安装过程」，而不是点一下就没反应。 */
  const setP = (stage2, pct) => progressMap.set(id, { stage: stage2, pct, at: Date.now() });
  setP('download', 0);

  try {
    onLog(`下载 ${id}…`);
    const got = await download(url, pkg, (pct) => setP('download', pct));
    setP('verify', 100);
    if (sha256 && got.toLowerCase() !== String(sha256).toLowerCase()) {
      throw new Error(`sha256 校验失败（期望 ${String(sha256).slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`);
    }
    onLog('校验通过，解包…');
    setP('install', 100);
    await tar.x({ file: pkg, cwd: stage });

    // 允许包内有一层顶层目录
    let root = stage;
    const kids = fs.readdirSync(stage);
    if (kids.length === 1 && fs.statSync(path.join(stage, kids[0])).isDirectory()) {
      root = path.join(stage, kids[0]);
    }
    const man = readManifest(root);
    if (!man) throw new Error('包内没有有效的 module.json');
    if (man.id !== id) throw new Error(`模块 id 不匹配（包内是 ${man.id}）`);

    // 原子替换
    const target = dirOf(id);
    const backup = `${target}.old-${Date.now()}`;
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    fs.renameSync(root, target);
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });

    onLog(`已安装 ${man.name || id} ${version || man.version || ''}`);
    settings.forgetKnown(id); // 真的装回来了 → 不再是「已删除」
    setP('done', 100);
    setTimeout(() => progressMap.delete(id), 15000);
    return readManifest(target);
  } catch (e) {
    progressMap.set(id, { stage: 'error', pct: 0, error: e.message, at: Date.now() });
    setTimeout(() => progressMap.delete(id), 15000);
    throw e;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

function uninstall(id) {
  const dir = dirOf(id);
  if (!fs.existsSync(dir)) return false;
  // 删之前先把「它是谁」记下来 —— 用户要求：删除后仍留在设置里，点「下载」就能装回来
  const man = readManifest(dir);
  if (man) settings.rememberModule(id, man);
  fs.rmSync(dir, { recursive: true, force: true });
  settings.forget(id);
  return true;
}

/* ---------------- 启停 + 依赖级联 ---------------- */

/** 已安装模块的 id → manifest */
function installedMap() {
  const m = {};
  for (const man of listInstalled()) m[man.id] = man;
  return m;
}

/**
 * 开启一个模块，并**自动级联开启它依赖的模块**。
 * 返回 { enabled: [...], missing: [...] }
 */
function enableWithDeps(id, seen = new Set()) {
  const map = installedMap();
  const man = map[id];
  if (!man) return { enabled: [], missing: [id] };
  if (seen.has(id)) return { enabled: [], missing: [] };
  seen.add(id);

  const enabled = [];
  const missing = [];
  for (const dep of man.requires || []) {
    if (!map[dep]) {
      missing.push(dep);
      continue;
    }
    const r = enableWithDeps(dep, seen);
    enabled.push(...r.enabled);
    missing.push(...r.missing);
  }
  settings.setEnabled(id, true);
  enabled.push(id);
  return { enabled, missing };
}

/** 停用：如果还有别的已启用模块依赖它，拒绝 */
function disableSafely(id) {
  const map = installedMap();
  const dependents = Object.values(map)
    .filter((m) => (m.requires || []).includes(id) && settings.isEnabled(m.id))
    .map((m) => m.id);
  if (dependents.length) {
    return { ok: false, blockedBy: dependents };
  }
  settings.setEnabled(id, false);
  return { ok: true, blockedBy: [] };
}

/* ---------------- 加载 ---------------- */

/**
 * 把已启用的模块挂到 express app 上。
 * 单个模块加载失败**不影响其它模块和主程序** —— 记日志并继续。
 */
function loadEnabled(app, ctx, log = () => {}) {
  const loaded = [];
  for (const man of listInstalled()) {
    if (!settings.isEnabled(man.id)) continue;
    const entry = path.join(dirOf(man.id), 'server.js');
    if (!fs.existsSync(entry)) {
      log(`模块 ${man.id} 缺少 server.js，跳过`);
      continue;
    }
    try {
      // eslint-disable-next-line global-require
      const mod = require(entry);
      if (typeof mod.register === 'function') {
        mod.register(app, { ...ctx, moduleId: man.id, manifest: man, config: settings.getConfig(man.id) });
        loaded.push(man.id);
      } else {
        log(`模块 ${man.id} 未导出 register()，跳过`);
      }
    } catch (e) {
      log(`模块 ${man.id} 加载失败：${e.message}`);
    }
  }
  return loaded;
}

/** 模块静态资源目录（供 express.static 挂载） */
function publicDirOf(id) {
  const d = path.join(dirOf(id), 'public');
  return fs.existsSync(d) ? d : null;
}

module.exports = {
  BASE_DIR,
  MODULES_DIR,
  DEFAULT_INDEX_URL,
  resolveIndexUrl,
  getProgress,
  listInstalled,
  installedMap,
  fetchIndex,
  install,
  uninstall,
  enableWithDeps,
  disableSafely,
  loadEnabled,
  publicDirOf,
  readManifest,
};

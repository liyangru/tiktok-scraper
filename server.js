/**
 * TikTok 多账号数据抓取服务
 *
 * 启动: node server.js
 * ⚠️ 端口**不写死**：默认从 8899 起探测，被占用（EADDRINUSE / EACCES / EADDRNOTAVAIL）
 *    自动往后顺延，实际监听端口由 start() 返回，并写入 <BASE_DIR>/runtime.json。
 *    宿主（Electron）必须用返回值拼 URL，不能自己拼默认端口。
 *
 * ⚠️ 绝不打开系统浏览器 —— 界面一律由宿主窗口（Electron）承载。
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const envfile = require('./lib/envfile');
const scraper = require('./lib/scraper');
const report = require('./lib/report');

// 可写基目录：单文件 exe（pkg）下 __dirname 是只读快照，必须由 bootstrap 注入 TT_BASE_DIR
const BASE_DIR = process.env.TT_BASE_DIR || __dirname;

// ⚠️ 必须在读取任何配置之前加载 .env —— 密钥只放在那里，不进 settings.json
envfile.load(path.join(BASE_DIR, '.env'));

const settings = require('./lib/settings');
const TTPeriod = require('./public/shared/period.js');
const TTMetrics = require('./public/shared/metrics.js');
const videodb = require('./lib/videodb');
const llm = require('./lib/llm');
const videodl = require('./lib/videodl');

const PORT = parseInt(process.env.PORT || '8899', 10);
const HOST = process.env.HOST || '127.0.0.1';
/** 实际监听端口写到这里，供同机其它进程/排查读取（start() 后写入） */
const RUNTIME_FILE = path.join(BASE_DIR, 'runtime.json');
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const DATA_DIR = path.join(BASE_DIR, 'data', 'jobs');
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '1', 10);
const MAX_SCROLLS = parseInt(process.env.MAX_SCROLLS || '400', 10);

fs.mkdirSync(DATA_DIR, { recursive: true });


/**
 * ⚠️ 崩溃日志与全局兜底 —— 任何一个未捕获异常都不允许把进程打死。
 *
 * 真实事故（Round 9）：`GET /api/jobs/:id` 里 `job.events` 为 undefined 触发 TypeError，
 * 异常逃出路由 → 进程直接退出。表现是**应用窗口还在、点什么都没反应**，
 * 用户根本无从判断发生了什么。所以这里：
 *   1) 全程只记日志、不退出，保证窗口和其它功能仍然可用；
 *   2) 日志同时落到 <BASE_DIR>/crash.log，便于事后回看。
 */
const CRASH_LOG = path.join(BASE_DIR, 'crash.log');
function logCrash(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${(err && err.stack) || String(err)}\n`;
  try { console.error(line); } catch (_) {}
  try { fs.appendFileSync(CRASH_LOG, line); } catch (_) {}
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- 访问鉴权（设了 ACCESS_TOKEN 才启用）----------
function parseCookies(s) {
  const out = {};
  (s || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  if (!ACCESS_TOKEN) return true;
  const t =
    req.query.token ||
    req.headers['x-access-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    parseCookies(req.headers.cookie).tk;
  return t === ACCESS_TOKEN;
}
function loginPage(err) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>需要访问口令</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#fbfbfb;
font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#111}
.b{width:320px;border:1px solid #dcdcdc;border-radius:4px;padding:28px;background:#fff}
h1{font-size:16px;margin:0 0 6px}p{font-size:12px;color:#7f7f7f;margin:0 0 18px}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #dcdcdc;border-radius:4px;background:#fafafa;font-size:13px;outline:none}
input:focus{border-color:#111;background:#fff}
button{width:100%;margin-top:12px;padding:11px;border:none;border-radius:4px;background:#111;color:#fff;font-size:13px;font-weight:600;cursor:pointer}
.e{color:#b42318;font-size:12px;margin-top:10px}</style></head><body><form class="b" method="GET" action="/">
<h1>TikTok 数据抓取</h1><p>请输入访问口令</p>
<input name="token" type="password" placeholder="访问口令" autofocus>
<button type="submit">进入</button>${err ? '<div class="e">口令不正确</div>' : ''}
</form></body></html>`;
}
app.use((req, res, next) => {
  if (!ACCESS_TOKEN) return next();
  if (req.path === '/api/health' || req.path === '/favicon.ico') return next();
  if (isAuthed(req)) {
    if (req.query.token) {
      res.setHeader('Set-Cookie', `tk=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    }
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: '未授权，请先访问首页输入口令' });
  res.status(401).send(loginPage(req.query.token !== undefined));
});

/**
 * ⚠️ 自有前端资源**禁缓存**。
 * express.static 默认允许缓存 → 更新后应用窗口仍用旧 app.js/index.html，
 * 用户会以为「更新没生效」（实际踩过）。
 */
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, must-revalidate'),
  })
);

/* ================= 设置 ================= */

app.get('/api/settings', (req, res) => {
  const core = settings.getCore();
  res.json({
    core,
    baseDir: BASE_DIR,
    envFile: settings.ENV_FILE,
  });
});

/** 只更新 core 的某几个字段（lang 等），前端切语言时会调 */
app.post('/api/settings/core', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (typeof b.lang === 'string' && ['zh', 'th', 'en'].includes(b.lang)) patch.lang = b.lang;
  if (typeof b.concurrency === 'number') patch.concurrency = b.concurrency;
  if (typeof b.headless === 'boolean') patch.headless = b.headless;
  if (!Object.keys(patch).length) return res.status(400).json({ error: '没有可更新的字段' });
  settings.setCore(patch);
  res.json({ ok: true, core: settings.getCore() });
});

app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  if (b.core && typeof b.core === 'object') settings.setCore(b.core);
  // 密钥写 .env，不落 settings.json
  if (b.secrets && typeof b.secrets === 'object') {
    const patch = {};
    for (const [k, v] of Object.entries(b.secrets)) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === 'string' && v.trim()) patch[k] = v.trim();
    }
    if (Object.keys(patch).length) envfile.write(settings.ENV_FILE, patch);
  }
  res.json({ ok: true, core: settings.getCore() });
});

/* ================= 抓取任务（与命令行 / 插件共用 lib/jobs.js） ================= */
const { createJobStore, JobError } = require('./lib/jobs');
const jobStore = createJobStore({
  dataDir: DATA_DIR,
  scraper,
  report,
  videodb,
  maxScrolls: MAX_SCROLLS,
  applySync: (rows, ranges, job) => applySync(rows, ranges, job),
  log: (m) => console.log(`  [job] ${m}`),
});
const sendErr = (res, e) => res.status(e instanceof JobError ? e.status : 500).json({ error: e.message });

/** 健康检查 */
const APP_VERSION = require('./package.json').version;
const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ');
/**
 * 存储位置：**默认在应用数据目录下，但允许用户在设置里手动改**（Round 6 用户明确要求）。
 * 规则：settings.core.downloadDir 有值就用它（用户改的），否则默认 <BASE_DIR>/downloads。
 */
function resolveDownloadDir() {
  const saved = (settings.getCore() || {}).downloadDir;
  if (saved && String(saved).trim()) return String(saved).trim();
  return path.join(BASE_DIR, 'downloads');
}

app.get('/api/settings/storage', (req, res) => {
  const dir = resolveDownloadDir();
  const custom = !!String((settings.getCore() || {}).downloadDir || '').trim();
  let exists = false;
  try { fs.mkdirSync(dir, { recursive: true }); exists = true; } catch (e) { /* 只读环境 */ }
  res.json({ downloadDir: dir, defaultDir: path.join(BASE_DIR, 'downloads'), custom, writable: exists, baseDir: BASE_DIR });
});

/** 用户手动修改下载目录：校验可写后持久化；传空 = 恢复默认 */
app.post('/api/settings/storage', (req, res) => {
  const want = String((req.body && req.body.downloadDir) || '').trim();
  if (!want) {
    settings.setCore({ downloadDir: '' });
    const dir = resolveDownloadDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    return res.json({ ok: true, downloadDir: dir, custom: false });
  }
  // 基本防护：不允许指到系统根目录这种明显错误的位置
  if (/^([a-zA-Z]:\\?$|\/$)/.test(want)) return res.status(400).json({ error: '不能把下载目录设为磁盘根目录' });
  try {
    fs.mkdirSync(want, { recursive: true });
    // 真的写一下试试，避免存了个只读路径
    const probe = path.join(want, `.tt-write-test-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    return res.status(400).json({ error: `目录不可写：${e.message}` });
  }
  settings.setCore({ downloadDir: want });
  res.json({ ok: true, downloadDir: want, custom: true });
});

/** 弹出系统文件夹选择器（用户要求：点路径框能选文件夹，而不是只能手输路径） */
app.post('/api/settings/storage/pick', async (req, res) => {
  let dialog = null;
  try {
    const electron = require('electron');
    dialog = electron && electron.dialog;
  } catch (_) {}
  if (!dialog || typeof dialog.showOpenDialog !== 'function') {
    return res.json({ ok: false, hint: 'dialog-unavailable' });
  }
  try {
    const cur = String((req.body && req.body.from) || '').trim();
    const r = await dialog.showOpenDialog({
      title: '选择下载文件夹',
      defaultPath: cur || path.join(BASE_DIR, 'downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return res.json({ ok: false, canceled: true });
    res.json({ ok: true, dir: r.filePaths[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 在系统的文件管理器里**查看**当前下载目录（只是打开看看） */
app.post('/api/settings/storage/open', (req, res) => {
  const dir = resolveDownloadDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  try {
    // Electron 宿主下用 shell（最稳，且不经过任何浏览器）
    const electron = require('electron');
    if (electron && electron.shell && typeof electron.shell.openPath === 'function') {
      const r = electron.shell.openPath(dir);
      if (r) return res.json({ ok: true, dir, warning: r });
      return res.json({ ok: true, dir });
    }
  } catch (_) {}
  return res.json({ ok: true, dir, hint: 'file manager unavailable' });
});

/* ---------------- AI（free-llm-gateway） ---------------- */

app.get('/api/settings/llm', (req, res) => {
  const env = envfile.read(settings.ENV_FILE);
  const base = process.env.LLM_BASE_URL || env.LLM_BASE_URL || '';
  const key = process.env.LLM_API_KEY || env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || env.LLM_MODEL || 'auto-ops';
  const vision = process.env.LLM_VISION_MODEL || env.LLM_VISION_MODEL || '';
  res.json({
    configured: !!(base && key),
    base,
    hasKey: !!key,
    keyHint: key ? `${key.slice(0, 4)}…${key.slice(-2)}（${key.length} 位）` : '',
    model: model || 'auto-ops',
    vision: vision || '',
    envFile: settings.ENV_FILE,
  });
});

/** 保存 AI 配置到 .env（密钥不进 settings.json） */
app.post('/api/settings/llm', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (typeof b.base === 'string') patch.LLM_BASE_URL = b.base.trim().replace(/\/+$/, '');
  if (typeof b.key === 'string' && b.key.trim()) patch.LLM_API_KEY = b.key.trim();
  if (typeof b.model === 'string') patch.LLM_MODEL = b.model.trim() || 'auto-ops';
  if (typeof b.vision === 'string') patch.LLM_VISION_MODEL = b.vision.trim();
  if (Object.keys(patch).length) envfile.write(settings.ENV_FILE, patch);
  // 立即生效：进程内的环境变量也同步一遍
  for (const [k, v] of Object.entries(patch)) process.env[k] = v;
  res.json({ ok: true, wrote: Object.keys(patch) });
});

/** 连通性自检：真的去网关问一句，不通就把错误原样报出来 */
app.post('/api/settings/llm/test', async (req, res) => {
  const started = Date.now();
  try {
    const txt = await llm.chat([{ role: 'user', content: '只回复两个字：可用' }], { maxTokens: 32 });
    res.json({ ok: true, ms: Date.now() - started, reply: String(txt).slice(0, 80) });
  } catch (e) {
    res.status(400).json({ error: e.message, ms: Date.now() - started });
  }
});

app.get('/api/videodb/stats', (req, res) => res.json(videodb.stats()));

app.get('/api/videos/:vid', (req, res) => {
  const v = videodb.load().videos[String(req.params.vid)];
  // 还没有历史快照不是错误：返回空历史，前端显示「暂无快照」
  if (!v) return res.json({ vid: String(req.params.vid), found: false, history: [] });
  res.json(v);
});

/* ==================== 应用自更新（发布后由应用自己拉，不再手动装） ====================
   应用是一个整体（2.1 起不再有可单独升级的模块），更新只有一条通道：
   先发版，再由这里检查更新，拿到安装包后一键静默安装。
   ⚠️ 仓库是私有的，GitHub API 要带 token（.env 的 UPDATE_TOKEN）；没有 token 就只报当前版本。 */
const UPDATE_REPO = process.env.UPDATE_REPO || 'liyangru/tiktok-scraper';
const UPDATE_FILE = path.join(BASE_DIR, 'data', 'update.json');

function readUpdateState() {
  try {
    return JSON.parse(fs.readFileSync(UPDATE_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}
function writeUpdateState(o) {
  try {
    fs.mkdirSync(path.dirname(UPDATE_FILE), { recursive: true });
    fs.writeFileSync(UPDATE_FILE, JSON.stringify(o, null, 2));
  } catch (_) {}
}

/** 比较 x.y.z 语义化版本；a<b 返回 -1 */
function cmpVersion(a, b) {
  const pa = String(a || '0').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

/** 查最新 Release（私有仓库需要 token） */
async function checkLatestRelease() {
  const token = (envfile.read(settings.ENV_FILE).UPDATE_TOKEN || '').trim();
  const headers = { 'User-Agent': 'TikTokScraper', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers });
  if (r.status === 404) throw new Error(`找不到 Release（${UPDATE_REPO} 还没有发过版，或仓库名不对）`);
  if (r.status === 401 || r.status === 403) throw new Error('GitHub 拒绝访问：私有仓库需要 UPDATE_TOKEN');
  if (!r.ok) throw new Error(`GitHub 返回 HTTP ${r.status}`);
  const j = await r.json();
  const latest = String(j.tag_name || '').replace(/^v/, '');
  const assets = (j.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }));
  const setup = assets.find((a) => /setup\.exe$/i.test(a.name));
  const portable = assets.find((a) => /portable\.exe$/i.test(a.name));
  return {
    latest,
    notes: (j.body || '').slice(0, 4000),
    publishedAt: j.published_at,
    htmlUrl: j.html_url,
    assets,
    setup: setup || null,
    portable: portable || null,
  };
}

/** 检查更新：?force=1 强制不看缓存 */
app.get('/api/update/check', async (req, res) => {
  const force = String(req.query.force || '') === '1';
  const st = readUpdateState();
  if (!force && st.checkedAt && Date.now() - st.checkedAt < 6 * 3600 * 1000 && st.result) {
    return res.json({ ...st.result, cached: true });
  }
  try {
    const rel = await checkLatestRelease();
    const result = {
      current: APP_VERSION,
      latest: rel.latest,
      hasUpdate: cmpVersion(APP_VERSION, rel.latest) < 0,
      notes: rel.notes,
      publishedAt: rel.publishedAt,
      htmlUrl: rel.htmlUrl,
      setup: rel.setup,
      portable: rel.portable,
      repo: UPDATE_REPO,
      hasToken: !!envfile.read(settings.ENV_FILE).UPDATE_TOKEN,
      error: '',
    };
    writeUpdateState({ checkedAt: Date.now(), result });
    res.json(result);
  } catch (e) {
    const result = { current: APP_VERSION, latest: '', hasUpdate: false, error: e.message, repo: UPDATE_REPO };
    writeUpdateState({ checkedAt: Date.now(), result });
    res.json(result);
  }
});

/** 下载安装包到下载目录，并可选地直接静默安装 */
app.post('/api/update/download', async (req, res) => {
  try {
    const body = req.body || {};
    const wantInstall = !!body.install;
    const st = readUpdateState();
    const rel = st.result || {};
    const asset = body.portable ? rel.portable : rel.setup || rel.portable;
    if (!asset || !asset.url) return res.status(400).json({ error: '没有可下载的安装包（先检查更新）' });
    const dir = path.join(resolveDownloadDir(), 'updates');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, asset.name);
    const r = await fetch(asset.url, { headers: { 'User-Agent': 'TikTokScraper' } });
    if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(out, buf);
    log(`已下载更新包：${out}（${(buf.length / 1048576).toFixed(1)}MB）`);
    let launched = false;
    if (wantInstall && /\.exe$/i.test(out)) {
      // NSIS 安装包支持 /S 静默安装；装完由用户重启（不在这里自动杀自己）
      const child = require('child_process').spawn(out, ['/S'], { detached: true, stdio: 'ignore' });
      child.unref();
      launched = true;
      log('已启动静默安装，安装完成后请重启应用');
    }
    res.json({ ok: true, file: out, size: buf.length, launched, installArg: launched ? '/S' : '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const chrome = scraper.resolveChromePath();
  res.json({
    ok: true,
    engine: scraper.ENGINE,
    chrome: chrome || null,
    chromeFound: !!chrome,
    concurrency: CONCURRENCY,
    headless: process.env.BROWSER_HEADLESS === '1',
    version: APP_VERSION,
    build: BUILD_STAMP,
  });
});

/** 提交抓取任务 */
app.post('/api/scrape', (req, res) => {
  const chrome = scraper.resolveChromePath();
  if (!chrome && process.env.BROWSER_HEADLESS !== '1') {
    return res.status(500).json({ error: '没找到 Chrome/Chromium，请设置环境变量 CHROME_PATH 指向浏览器可执行文件' });
  }
  try {
    const job = jobStore.create({ ...(req.body || {}), source: 'app' });
    const { id, from, to, handles, currentFrom, currentTo, compareFrom, compareTo, compareMode } = job;
    res.json({ id, from, to, handles, currentFrom, currentTo, compareFrom, compareTo, compareMode });
  } catch (e) {
    sendErr(res, e);
  }
});

/** 停止任务：真正中断后台抓取（关闭浏览器），已完成账号的数据保留 */
app.post('/api/jobs/:id/stop', (req, res) => {
  try {
    const job = jobStore.stop(req.params.id);
    res.json({ ok: true, status: job.status });
  } catch (e) {
    sendErr(res, e);
  }
});

/** 删除任务（单条 / 批量） */
app.delete('/api/jobs/:id', (req, res) => res.json({ ok: true, deleted: jobStore.remove([req.params.id]) }));
app.post('/api/jobs/delete', (req, res) => {
  const ids = (req.body && req.body.ids) || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '没有选中任务' });
  res.json({ ok: true, deleted: jobStore.remove(ids) });
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(await jobStore.view(job));
});

/** 历史任务（含命令行 / 插件建的任务） */
app.get('/api/jobs', (req, res) => res.json(jobStore.list()));

/** 简报：给「复制简报」和插件用的精简摘要 */
app.get('/api/jobs/:id/summary', async (req, res) => {
  const job = jobStore.get(req.params.id);
  if (!job || !jobStore.isFinished(job)) return res.status(404).json({ error: '任务不存在或尚未完成' });
  res.json(await jobStore.summarize(job, { cartMode: req.query.cart === 'trim' ? 'trim' : 'mean' }));
});

const langOf = (req) => (['zh', 'th', 'en'].includes(req.query.lang) ? req.query.lang : 'zh');
app.get('/api/jobs/:id/export.xlsx', async (req, res) => {
  const job = jobStore.get(req.params.id);
  if (!job || !job.results) return res.status(404).send('任务不存在或尚未完成');
  try {
    const { name, buffer } = await jobStore.exportXlsx(job, langOf(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    res.end(buffer);
  } catch (e) {
    res.status(e.status || 500).send(e.message);
  }
});
app.get('/api/jobs/:id/export.csv', async (req, res) => {
  const job = jobStore.get(req.params.id);
  if (!job || !job.results) return res.status(404).send('任务不存在或尚未完成');
  try {
    const { name, text } = await jobStore.exportCsv(job, langOf(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    res.send(text);
  } catch (e) {
    res.status(e.status || 500).send(e.message);
  }
});

/**
 * 手动触发一次平台数据同步（创作中心 / 卖家中心），并**把结果回写进 job.results**。
 *
 * 为什么必须有这个：applySync 原本只在抓取任务收尾、导出文件时跑。
 * 用户「导入创作中心数据」是抓完之后才做的独立动作，此时 rows 早已渲染完，
 * 同步结果没人应用 —— 界面上就是「导入了但明细一点变化都没有」。
 * 这个端点把同步结果写回 job.rows，前端重新拉一次就能看到 avgWatchTime / finishRate 等字段。
 */
app.post('/api/jobs/:id/sync', async (req, res) => {
  const job = jobStore.get(req.params.id);
  if (!job || !job.results) return res.status(404).json({ error: '任务不存在或尚未完成' });
  if (!SYNC_PROVIDERS.length) return res.status(400).json({ error: '没有可用的平台数据源' });
  const rows = report.toRows(job.results, jobStore.ranges(job));
  const before = rows.filter((r) => r.avgWatchTime !== undefined || r.gmv !== undefined || r.finishRate !== undefined).length;
  await applySync(rows, jobStore.ranges(job), job);
  const after = rows.filter((r) => r.avgWatchTime !== undefined || r.gmv !== undefined || r.finishRate !== undefined).length;
  // 回写，让后续导出与前端刷新都能拿到这份数据
  job.rows = rows;
  res.json({
    ok: true,
    total: rows.length,
    matched: after,
    added: Math.max(0, after - before),
    rows,
    summary: job.results
      ? job.results.map((r) => ({
          handle: r.handle,
          nickname: r.nickname,
          stats: r.stats,
          ...report.agg(rows.filter((x) => x.account === r.handle)),
        }))
      : [],
  });
});


/* ================= AI 经营分析（默认自动出，不需要点击） =================
 * 用户要求：抓到数据后就有固定模板和维度的 AI 分析，直接放在概览里；
 * 设了对比期时必须结合对比期一起分析。LLM 配置复用 .env（LLM_*）。
 * 结果缓存进 job.json（aiBrief / aiBriefAt），同一个任务不重复花钱。
 */
const AI_BRIEF_MARKDOWN = (d) => `你是 TikTok 电商内容运营专家。基于下面这份本机抓取的运营数据，输出一份「AI 分析」。
用简体中文，Markdown，总长 500 字以内，直接给判断和动作，禁止空话套话。固定输出以下章节：

### 一句话结论
（本期整体好/坏/平稳，一句话说清主要矛盾）

### 流量健康度
（总播放/中位播放/爆oldest率；点赞率、评论率、分享率、收藏率各自处于什么水平——哪项是短板；条均播放与头尾差距说明什么）

### 内容画像
（TOP 视频的共同点：主题方向 / 发布时间 / 时长 / 挂车情况；哪类内容在扛量，哪类在拖后腿）

### 转化与挂车
（挂车视频占比与播放占比、挂车 vs 非挂车的互动差；给「该不该加大挂车」一个明确判断）

### 对比期诊断
（没有对比期就写「本期为独立分析」；有则必须给：环比变化最大的 2-3 个指标、涨跌原因推测、机会或风险）

### 行动建议
（3-5 条，每条一行，具体到可执行：比如「发布时间集中到 17:00-18:00」「复制 TOP1 的 hook 结构再拍 3 条」）

数据：
${d}`;

function fmtPct(x) {
  return x === null || x === undefined ? '—' : (x * 100).toFixed(2) + '%';
}
function briefAggText(label, a) {
  if (!a || !a.n) return `${label}：无数据`;
  return [
    `${label}：${a.n} 条视频`,
    `总播放 ${a.tv}，平均 ${a.avg}，中位 ${a.med}，最高 ${a.max}`,
    `点赞 ${a.likes}（均 ${a.avgLikes}）、评论 ${a.comments}（均 ${a.avgComments}）`,
    `分享 ${a.shares}（均 ${a.avgShares}）、收藏 ${a.saves}（均 ${a.avgSaves}）、转发 ${a.reposts}（均 ${a.avgReposts}）`,
    `互动率 ${fmtPct(a.inter)}，条均互动 ${a.avgInter}，平均时长 ${a.avgDuration}s`,
    `挂车 ${a.ecN} 条（播放 ${a.ecViews}），非挂车 ${a.nonEcN} 条（播放 ${a.nonEcViews}）`,
  ].join('；');
}

app.get('/api/jobs/:id/ai-brief', async (req, res) => {
  const job = jobStore.get(req.params.id);
  if (!job || !job.results) return res.status(404).json({ error: '任务不存在或尚未完成' });
  if (job.aiBrief) return res.json({ ok: true, cached: true, brief: job.aiBrief, at: job.aiBriefAt });
  const ranges = jobStore.ranges(job);
  const rows = job.rows && job.rows.length ? job.rows : report.toRows(job.results, ranges);
  if (!rows.length) return res.status(400).json({ error: '该任务没有数据' });
  await applySync(rows, ranges, job); // 平台数据（GMV/完播率…）能合多少合多少

  const hasCompare = !!(ranges.compareFrom && ranges.compareTo);
  const cur = report.currentRows(rows);
  const cmpRows = rows.filter((r) => TTMetrics.inCompare(r));
  const pcCur = report.agg(cur);
  const pcCmp = report.agg(cmpRows);
  const top = [...cur].sort((a, b) => b.views - a.views).slice(0, 8);
  const worst = [...cur].sort((a, b) => a.views - b.views).slice(0, 3);
  const ecd = report.ecCompare(cur);
  const curDays = TTPeriod.span(ranges.currentFrom, ranges.currentTo);
  const cmpDays = hasCompare ? TTPeriod.span(ranges.compareFrom, ranges.compareTo) : 0;

  const lines = [];
  lines.push(`账号：${(job.results || []).map((a) => `@${a.handle}（粉丝 ${(a.stats && a.stats.followerCount) || '?'}）`).join('；')}`);
  lines.push(`本期区间：${ranges.currentFrom} ~ ${ranges.currentTo}（${curDays} 天）`);
  lines.push(briefAggText('本期', pcCur));
  if (hasCompare) {
    lines.push(`对比期区间：${ranges.compareFrom} ~ ${ranges.compareTo}（${cmpDays} 天）`);
    lines.push(briefAggText('对比期', pcCmp));
    if (curDays !== cmpDays) lines.push('两期天数不同：比较时请以日均和条均为准，不要直接比总量');
    if (!pcCmp.n) lines.push('对比期没有发布视频（当期无内容可对比）');
  } else {
    lines.push('未设置对比期');
  }
  lines.push(`TOP 视频：${top.map((r) => `「${(r.desc || '').slice(0, 26)}」${r.date} ${r.time} ${r.views}播放 互率${fmtPct(r.inter)}${r.isEC ? ' 挂车' : ''}`).join('；')}`);
  lines.push(`最差视频：${worst.map((r) => `「${(r.desc || '').slice(0, 20)}」${r.views}播放`).join('；')}`);
  lines.push(`挂车 vs 非挂车：挂车均播 ${ecd.ec.n ? ecd.ec.avg : 0} / 非挂车均播 ${ecd.non.n ? ecd.non.avg : 0}；挂车互动率 ${fmtPct(ecd.ec.inter)} / 非挂车 ${fmtPct(ecd.non.inter)}`);
  const ecRows = rows.filter((r) => r.gmv !== undefined);
  if (ecRows.length) {
    const gmvSum = ecRows.reduce((s, r) => s + (Number(r.gmv) || 0), 0);
    lines.push(`卖家中心已匹配 ${ecRows.length} 条，合计 GMV ${gmvSum.toFixed(2)}`);
  }

  try {
    const brief = await llm.chat([
      { role: 'system', content: '你是 TikTok 电商内容运营专家，输出直接、具体、可执行的中文 Markdown 分析。' },
      { role: 'user', content: AI_BRIEF_MARKDOWN(lines.join('\n')) },
    ], { maxTokens: 1400 });
    job.aiBrief = brief;
    job.aiBriefAt = new Date().toISOString();
    jobStore.save(job);
    res.json({ ok: true, cached: false, brief, at: job.aiBriefAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 清除缓存强制重新分析（前端「重新分析」用） */
app.delete('/api/jobs/:id/ai-brief', (req, res) => {
  const job = jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  job.aiBrief = null;
  job.aiBriefAt = null;
  jobStore.save(job);
  res.json({ ok: true });
});

/* ================= 双平台数据同步框架（创作中心 / 卖家中心） ================= */
/**
 * 内置功能通过 FEATURE_CTX.registerSync({ platform, collect }) 注册同步源。
 * collect({ rows, ranges, job }) 返回 { <vid>: { 字段: 值, … } }（可以是 async）。
 * 核心在出报表时把这些字段**合并进右侧视频列表的行**：
 *   - 重合字段（播放/点赞等以 TikTok 抓取为准）一律剔除，绝不覆盖 —— 数据原则：TikTok 为主
 *   - 只有平台独有字段（GMV/订单/完播率/平均观看时长…）才落到行上
 */
const SYNC_PROVIDERS = [];
/** 重合字段黑名单：这些列以 TikTok 抓取为准，平台数据不许覆盖 */
const SYNC_RESERVED = new Set([
  'vid', 'url', 'account', 'date', 'time', 'desc', 'tags', 'views', 'likes', 'comments',
  'shares', 'saves', 'reposts', 'duration', 'inter', 'isEC', 'isAd', 'isAIGC', 'lang',
  'music', 'resolution', 'playUrl', 'period', 'vv',
]);

async function applySync(rows, ranges, job) {
  if (!rows.length || !SYNC_PROVIDERS.length) return rows;
  for (const p of SYNC_PROVIDERS) {
    try {
      const map = (await p.collect({ rows, ranges, job })) || {};
      let hit = 0;
      for (const r of rows) {
        const extra = map[String(r.vid)];
        if (!extra) continue;
        hit++;
        for (const [k, v] of Object.entries(extra)) {
          if (SYNC_RESERVED.has(k)) continue; // 剔除重合字段
          r[k] = v;
        }
        if (p.platform === 'seller') r.isEC = true; // 卖家中心匹配上 = 挂车（权威判定）
      }
      if (hit) console.log(`  [sync] ${p.platform}：合并 ${hit} 条平台数据`);
    } catch (e) {
      console.log(`  ⚠ [sync] ${p.platform} 同步失败：${e.message}`);
    }
  }
  // 平台指标也沉淀进历史点 —— 「指标趋势」需要第二个数据来源（创作中心/卖家中心），
  // 否则永远只有 TikTok 快照一条线，用户说得对：一个来源看不出什么趋势。
  try {
    const n = videodb.upsertPlatform(rows);
    if (n) console.log(`  [sync] 已把 ${n} 条平台指标写入历史（趋势图第二来源）`);
  } catch (e) {
    console.log(`  ⚠ [sync] 平台指标写历史失败：${e.message}`);
  }
  return rows;
}

/* ================= 内置功能 =================
 * 2.1 起取消「模块商店」：创作中心登录、卖家中心数据、AI 分析都是应用的固定组成部分，
 * 代码按功能拆在 lib/features/ 下，启动时直接挂载。单个功能挂载失败只记日志，不影响主程序。
 */
const FEATURE_CTX = {
  baseDir: BASE_DIR,
  dataDir: DATA_DIR,
  settings,
  envfile,
  log: (m) => console.log(`  [feature] ${m}`),
  registerSync: (p) => {
    if (p && p.platform && typeof p.collect === 'function') SYNC_PROVIDERS.push(p);
  },
  core: {
    scraper,
    report,
    exceljs: require('exceljs'),
    envfile,
    chromium: require('patchright').chromium, // 套壳浏览器用（创作中心 / 卖家中心登录）
    llm,
    videodb,
  },
};

/** 视频解析与下载 */
videodl.register(app, {
  core: { scraper },
  log: (m) => console.log(`  [videodl] ${m}`),
  getOutDir: resolveDownloadDir,
});

const FEATURES = ['creator-login', 'seller-center', 'ai-video'];
const LOADED_FEATURES = [];
for (const name of FEATURES) {
  try {
    require(`./lib/features/${name}.js`).register(app, FEATURE_CTX);
    LOADED_FEATURES.push(name);
  } catch (e) {
    logCrash(`feature ${name}`, e);
  }
}

/**
 * ⚠️ /api/* 未命中任何路由时，express 默认回一页 HTML 404 ——
 * 前端 `fetch(...).then(x => x.json())` 会直接抛 SyntaxError，
 * 用户看到的就是一句「请求失败」，完全看不出是接口拼错还是后端没这个功能。
 * 这里统一成 JSON 404。必须放在所有路由之后、错误中间件之前
 * （错误中间件是 arity=4，它之后的普通中间件 express 不会再走）。
 */
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在: ' + req.method + ' ' + req.originalUrl });
});

/**
 * ⚠️ 兜底错误中间件 —— 必须放在**所有路由之后**。
 * express 默认把漏出来的异常渲染成 HTML 堆栈页，前端解析不了，只会显示「请求失败」。
 * 统一转成 JSON：前端能直接把 message 显示出来，用户至少知道哪一步挂了。
 */
app.use((err, req, res, next) => {
  logCrash(`route ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: (err && err.message) || '服务器内部错误' });
});

/** 写入实际端口，供同机排查 / 宿主二次读取（「端口不能写死」的落地：以实际值为准） */
function writeRuntime(port) {
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    fs.writeFileSync(
      RUNTIME_FILE,
      JSON.stringify({ host: HOST, port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2) + '\n'
    );
  } catch (e) {
    /* 只读环境不影响运行 */
  }
}

/**
 * 端口占用时自动往后找空闲端口，避免和其它软件撞车。resolve **实际监听端口**。
 * ⚠️ 宿主必须拿 resolve 出来的端口拼 URL，绝不自己拼默认值 ——
 *    否则用户机器上 8899 被占时就会出现「窗口白屏 / 打开的是别人服务」。
 */
function listen(port, tries = 50) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, HOST);
    srv.on('listening', () => {
      const chrome = scraper.resolveChromePath();
      if (port !== PORT) console.log(`  ⚠ 端口 ${PORT} 已被占用，自动改用 ${port}`);
      console.log('');
      console.log('  TikTok 多账号数据抓取服务已启动');
      console.log(`  → http://${HOST}:${port}`);
      console.log(`  浏览器: ${chrome || '未找到（请检查自带浏览器载荷）'}`);
      console.log(`  存储位置: ${resolveDownloadDir()}`);
      console.log(`  并发数: ${CONCURRENCY}   有头模式: ${process.env.BROWSER_HEADLESS === '1' ? '否' : '是'}`);
      console.log(`  访问口令: ${ACCESS_TOKEN ? '已启用' : '未启用（仅限本机使用）'}`);
      console.log(`  内置功能: ${LOADED_FEATURES.join(', ')}`);
      console.log('');
      writeRuntime(port);
      /* ⚠️ 这里**不打开任何浏览器** —— 用户硬要求：所有界面只在应用窗口内。
         直接 node server.js 时请自行访问上面打印的地址。 */
      resolve(port);
    });
    srv.on('error', (e) => {
      // EACCES / EADDRNOTAVAIL 也要换端口：
      // Windows 上其它进程绑了 0.0.0.0:port 时，绑 127.0.0.1:port 会报 EACCES（而非 EADDRINUSE）
      // —— 用户机器上就发生过，导致「双击没反应」。
      const busy = e.code === 'EADDRINUSE' || e.code === 'EACCES' || e.code === 'EADDRNOTAVAIL';
      if (busy && tries > 0) {
        console.log(`  ⚠ 端口 ${port} 不可用（${e.code}），尝试 ${port + 1}`);
        try { srv.close(); } catch (_) {}
        listen(port + 1, tries - 1).then(resolve, reject);
      } else {
        reject(e);
      }
    });
  });
}

/** 启动服务，resolve 实际监听端口 */
function start(portOverride) {
  return listen(portOverride || PORT);
}

module.exports = { app, start, settings };

if (require.main === module) {
  start().catch((e) => {
    console.error('启动失败:', e.message);
    process.exit(1);
  });
}

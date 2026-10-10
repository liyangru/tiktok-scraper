/**
 * TikTok 多账号数据抓取服务
 * 启动: node server.js   （默认 http://127.0.0.1:8787）
 */
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const express = require('express');
const envfile = require('./lib/envfile');
const scraper = require('./lib/scraper');
const report = require('./lib/report');

// 可写基目录：单文件 exe（pkg）下 __dirname 是只读快照，必须由 bootstrap 注入 TT_BASE_DIR
const BASE_DIR = process.env.TT_BASE_DIR || __dirname;

// ⚠️ 必须在读取任何配置之前加载 .env —— 密钥只放在那里，不进 settings.json
envfile.load(path.join(BASE_DIR, '.env'));

const settings = require('./lib/settings');
const modules = require('./lib/modules');

const PORT = parseInt(process.env.PORT || '8899', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const DATA_DIR = path.join(BASE_DIR, 'data', 'jobs');
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '1', 10);
const MAX_SCROLLS = parseInt(process.env.MAX_SCROLLS || '400', 10);

fs.mkdirSync(DATA_DIR, { recursive: true });

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

app.use(express.static(path.join(__dirname, 'public')));

// 已安装模块的前端资源 → /modules/<id>/…
// ⚠️ app.use('/modules') 会把挂载前缀从 req.url 里剥掉，所以 req.url 已是 /<id>/…；
//    还要再把 <id> 这一段剥掉，才能映射到 <模块>/public/xxx —— 不剥就 404。
app.use('/modules', (req, res, next) => {
  const seg = String(req.url).split('/').filter(Boolean);
  const id = seg[0];
  if (!id) return next();
  const dir = modules.publicDirOf(id);
  if (!dir) return res.status(404).end();
  req.url = '/' + seg.slice(1).join('/');
  express.static(dir)(req, res, next);
});

/* ================= 设置 ================= */

app.get('/api/settings', (req, res) => {
  const core = settings.getCore();
  res.json({
    core,
    /* 密钥只回「是否已配置」，绝不回显明文 */
    secrets: {
      TTS_APP_KEY: envfile.has(settings.ENV_FILE, 'TTS_APP_KEY'),
      TTS_APP_SECRET: envfile.has(settings.ENV_FILE, 'TTS_APP_SECRET'),
      TTS_ACCESS_TOKEN: envfile.has(settings.ENV_FILE, 'TTS_ACCESS_TOKEN'),
      TTM_APP_ID: envfile.has(settings.ENV_FILE, 'TTM_APP_ID'),
      TTM_APP_SECRET: envfile.has(settings.ENV_FILE, 'TTM_APP_SECRET'),
    },
    baseDir: BASE_DIR,
    envFile: settings.ENV_FILE,
  });
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

/* ================= 模块 ================= */

app.get('/api/modules', async (req, res) => {
  const installed = modules.installedMap();
  let index = [];
  let indexError = '';
  try {
    index = await modules.fetchIndex();
  } catch (e) {
    indexError = e.message;
  }
  const list = index.map((m) => ({
    ...m,
    installed: !!installed[m.id],
    installedVersion: installed[m.id] ? installed[m.id].version : '',
    enabled: !!installed[m.id] && settings.isEnabled(m.id),
    updateAvailable: !!(installed[m.id] && m.version && installed[m.id].version !== m.version),
  }));
  // 已装但索引里没有的（本地开发的模块）也列出来
  for (const [id, man] of Object.entries(installed)) {
    if (!list.some((x) => x.id === id)) {
      list.push({ ...man, installed: true, installedVersion: man.version, enabled: settings.isEnabled(id), local: true });
    }
  }
  res.json({ indexError, modules: list, dir: modules.MODULES_DIR });
});

app.post('/api/modules/:id/install', async (req, res) => {
  const id = req.params.id;
  try {
    const index = await modules.fetchIndex();
    const entry = index.find((m) => m.id === id);
    if (!entry) return res.status(404).json({ error: `索引里没有模块 ${id}` });
    const man = await modules.install(entry);
    // 下载即启用（含依赖级联）—— 用户要求「下载了就可以重启出现在应用里」
    const en = modules.enableWithDeps(id);
    res.json({
      ok: true,
      module: man,
      enabled: en.enabled,
      missingDeps: en.missing,
      restartRequired: true,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/modules/:id', (req, res) => {
  const id = req.params.id;
  if (settings.isEnabled(id)) {
    const r = modules.disableSafely(id);
    if (!r.ok) return res.status(409).json({ error: `被这些已启用模块依赖，无法卸载：${r.blockedBy.join(', ')}` });
  }
  const ok = modules.uninstall(id);
  res.json({ ok, restartRequired: true });
});

app.post('/api/modules/:id/toggle', (req, res) => {
  const id = req.params.id;
  const want = !!(req.body && req.body.enabled);
  if (want) {
    const r = modules.enableWithDeps(id);
    if (r.missing.length) {
      return res.status(409).json({ error: `缺少依赖模块：${r.missing.join(', ')}`, enabled: r.enabled });
    }
    return res.json({ ok: true, enabled: r.enabled, restartRequired: true });
  }
  const r = modules.disableSafely(id);
  if (!r.ok) return res.status(409).json({ error: `这些已启用模块依赖它，请先停用它们：${r.blockedBy.join(', ')}` });
  res.json({ ok: true, enabled: [], restartRequired: true });
});

/* ================= 核心 ================= */

/** 内存中的任务表 */
const jobs = new Map();

function saveJob(job) {
  const p = path.join(DATA_DIR, `${job.id}.json`);
  fs.writeFileSync(p, JSON.stringify(job));
}
function loadJobsFromDisk() {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      jobs.set(j.id, j);
    } catch (e) {}
  }
}

function newId() {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 7);
}

function cleanHandle(s) {
  return String(s || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, '')
    .replace(/^@/, '')
    .split(/[/?#]/)[0]
    .trim();
}

function todayBangkok() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 健康检查 */
app.get('/api/health', (req, res) => {
  const chrome = scraper.resolveChromePath();
  res.json({
    ok: true,
    engine: scraper.ENGINE,
    chrome: chrome || null,
    chromeFound: !!chrome,
    concurrency: CONCURRENCY,
    headless: process.env.BROWSER_HEADLESS === '1',
  });
});

/** 提交抓取任务 */
app.post('/api/scrape', async (req, res) => {
  const body = req.body || {};
  const raw = Array.isArray(body.handles) ? body.handles : String(body.handles || '').split(/[\n,，;；\s]+/);
  const handles = [...new Set(raw.map(cleanHandle).filter(Boolean))];
  if (!handles.length) return res.status(400).json({ error: '请至少填写一个 TikTok 用户名' });
  if (handles.length > 20) return res.status(400).json({ error: '单次最多 20 个账号' });
  for (const h of handles) {
    if (!/^[A-Za-z0-9._]{2,40}$/.test(h)) return res.status(400).json({ error: `用户名格式不对: ${h}` });
  }

  const chrome = scraper.resolveChromePath();
  if (!chrome && process.env.BROWSER_HEADLESS !== '1') {
    return res.status(500).json({ error: '没找到 Chrome/Chromium，请设置环境变量 CHROME_PATH 指向浏览器可执行文件' });
  }

  const to = body.to || todayBangkok();
  const from = body.from || to.slice(0, 8) + '01';

  const job = {
    id: newId(),
    createdAt: new Date().toISOString(),
    status: 'queued',
    handles,
    from,
    to,
    concurrency: Math.max(1, Math.min(parseInt(body.concurrency, 10) || CONCURRENCY, 3)),
    events: [],
    accounts: [],
    error: null,
    finishedAt: null,
  };
  jobs.set(job.id, job);
  saveJob(job);
  res.json({ id: job.id, from, to, handles, concurrency: job.concurrency });

  runJob(job).catch((e) => {
    job.status = 'error';
    job.error = e.message || String(e);
    job.finishedAt = new Date().toISOString();
    saveJob(job);
  });
});

async function runJob(job) {
  job.status = 'running';
  saveJob(job);

  const push = (ev) => {
    job.events.push({ t: Date.now(), ...ev });
    if (job.events.length > 500) job.events.splice(0, job.events.length - 500);
    // 记录每账号状态
    if (ev.type === 'account-start') {
      let a = job.accounts.find((x) => x.handle === ev.handle);
      if (!a) {
        a = { handle: ev.handle, state: 'running', found: 0, count: 0 };
        job.accounts.push(a);
      }
      a.state = 'running';
      a.attempt = ev.attempt || 1;
    } else if (ev.type === 'account-retry') {
      const a = job.accounts.find((x) => x.handle === ev.handle);
      if (a) {
        a.state = 'retrying';
        a.attempt = (ev.attempt || 1) + 1;
      }
    } else if (ev.type === 'account-progress') {
      const a = job.accounts.find((x) => x.handle === ev.handle);
      if (a) a.found = ev.found;
    } else if (ev.type === 'account-done') {
      const a = job.accounts.find((x) => x.handle === ev.handle);
      if (a) {
        a.state = 'done';
        a.count = ev.count;
        a.stats = ev.stats;
      }
    }
  };

  const results = await scraper.scrapeMany(job.handles, {
    from: job.from,
    to: job.to,
    concurrency: job.concurrency,
    maxScrolls: MAX_SCROLLS,
    onEvent: push,
  });

  for (const h of job.handles) {
    const a = job.accounts.find((x) => x.handle === h);
    if (a && a.state === 'running') a.state = 'failed';
  }

  job.results = results.map((r) => ({
    handle: r.handle,
    nickname: r.nickname,
    stats: r.stats,
    items: r.items,
  }));
  job.rowCount = report.toRows(job.results).length;
  job.status = 'done';
  job.finishedAt = new Date().toISOString();
  saveJob(job);
}

/** 查询任务 */
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  const rows = job.results ? report.toRows(job.results) : [];
  res.json({
    id: job.id,
    status: job.status,
    error: job.error,
    from: job.from,
    to: job.to,
    handles: job.handles,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    accounts: job.accounts,
    events: job.events.slice(-60),
    rows,
    summary: job.results
      ? job.results.map((r) => ({ handle: r.handle, nickname: r.nickname, stats: r.stats, ...report.agg(rows.filter((x) => x.account === r.handle)) }))
      : [],
  });
});

/** 历史任务 */
app.get('/api/jobs', (req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 50)
    .map((j) => ({ id: j.id, status: j.status, handles: j.handles, from: j.from, to: j.to, createdAt: j.createdAt, rowCount: j.rowCount || 0 }));
  res.json(list);
});

app.delete('/api/jobs/:id', (req, res) => {
  jobs.delete(req.params.id);
  const p = path.join(DATA_DIR, `${req.params.id}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
});

function rangeLabel(job) {
  return `${job.from} ~ ${job.to}`;
}

/** 导出 Excel */
app.get('/api/jobs/:id/export.xlsx', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.results) return res.status(404).send('任务不存在或尚未完成');
  const rows = report.toRows(job.results);
  if (!rows.length) return res.status(404).send('该区间内没有数据');
  const lang = ['zh', 'th', 'en'].includes(req.query.lang) ? req.query.lang : 'zh';
  const wb = await report.buildWorkbook({
    rows,
    accounts: job.results.map((r) => ({ handle: r.handle, nickname: r.nickname, stats: r.stats })),
    title: `TikTok · ${job.handles.join(' / ')}`,
    rangeLabel: rangeLabel(job),
    lang,
  });
  const name = `tiktok_${job.handles.join('_').slice(0, 40)}_${job.from}_${job.to}_${lang}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
  await wb.xlsx.write(res);
  res.end();
});

/** 导出 CSV */
app.get('/api/jobs/:id/export.csv', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.results) return res.status(404).send('任务不存在或尚未完成');
  const rows = report.toRows(job.results);
  const lang = ['zh', 'th', 'en'].includes(req.query.lang) ? req.query.lang : 'zh';
  const name = `tiktok_${job.handles.join('_').slice(0, 40)}_${job.from}_${job.to}_${lang}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
  res.send(report.buildCsv(rows, lang));
});

loadJobsFromDisk();

/** 启动后打开「应用窗口」。
 *  - 用**自带 Chromium** 以 --app 方式开一个无地址栏/无标签页的独立窗口（不碰系统默认浏览器）
 *  - 只有找不到自带浏览器时才回退到系统浏览器
 *  - 设 NO_AUTO_OPEN=1 可完全关闭 */
function openBrowser(host, port) {
  if (process.env.NO_AUTO_OPEN) return;
  const url = `http://${host}:${port}`;
  setTimeout(() => {
    try {
      const chrome = scraper.resolveChromePath && scraper.resolveChromePath();
      if (chrome) {
        const profile = path.join(BASE_DIR, 'ui-profile');
        // 清理上次异常退出残留的单例锁：否则 Chromium 会误判“已有实例在跑”而直接退出 → 窗口打不开
        for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
          try { fs.rmSync(path.join(profile, f), { force: true }); } catch (_) {}
        }
        const child = spawn(
          chrome,
          [
            `--app=${url}`,
            `--user-data-dir=${profile}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=ChromeForTestingBanner',
            '--window-size=1440,960',
          ],
          { detached: true, stdio: 'ignore' }
        );
        child.unref();
        // 关掉界面窗口 = 退出整个程序（否则后台会残留一个没有窗口的进程）
        const startedAt = Date.now();
        child.on('exit', () => {
          if (Date.now() - startedAt > 2000) setTimeout(() => process.exit(0), 300);
        });
        return;
      }
      // 兜底：没有自带浏览器才用系统浏览器
      const cmd =
        process.platform === 'darwin'
          ? `open "${url}"`
          : process.platform === 'win32'
            ? `start "" "${url}"`
            : `xdg-open "${url}"`;
      exec(cmd);
    } catch (e) {}
  }, 1200);
}

/** 端口被占用时自动往后找空闲端口，避免和其它项目撞车。resolve 实际监听端口 */
/* ================= 模块加载 ================= */

/**
 * 模块能拿到的核心能力。
 * ⚠️ 模块在**主进程内**运行，不是沙箱 —— 所以只从本仓库安装模块。
 */
const MODULE_CTX = {
  baseDir: BASE_DIR,
  dataDir: DATA_DIR,
  settings,
  envfile,
  log: (m) => console.log(`  [module] ${m}`),
  /* ⚠️ 模块能 require 的库只限这里给的 —— pkg 打包后模块在快照外，自己 require 不到核心依赖 */
  core: {
    scraper,
    report,
    exceljs: require('exceljs'),
    envfile,
    chromium: require('patchright').chromium, // 套壳浏览器用（卖家中心登录）
  },
};

/** 已启用的模块在此挂载；单个模块加载失败不影响主程序与其它模块 */
const LOADED_MODULES = modules.loadEnabled(app, MODULE_CTX, (m) => console.log(`  ⚠ 模块：${m}`));

function listen(port, tries = 12) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, HOST);
    srv.on('listening', () => {
      const chrome = scraper.resolveChromePath();
      if (port !== PORT) console.log(`  ⚠ 端口 ${PORT} 已被占用，自动改用 ${port}`);
      console.log('');
      console.log('  TikTok 多账号数据抓取服务已启动');
      console.log(`  → http://${HOST}:${port}`);
      console.log(`  浏览器: ${chrome || '未找到（请设置 CHROME_PATH）'}`);
      console.log(`  并发数: ${CONCURRENCY}   有头模式: ${process.env.BROWSER_HEADLESS === '1' ? '否' : '是'}`);
      console.log(`  访问口令: ${ACCESS_TOKEN ? '已启用' : '未启用（仅限本机使用）'}`);
      console.log(`  模块: ${LOADED_MODULES.length ? LOADED_MODULES.join(', ') : '无（可在设置里下载）'}`);
      console.log('');
      // 仅「直接运行 server.js」时自动开界面；被 Electron 等宿主 require 时由宿主自己开窗
      if (require.main === module) openBrowser(HOST, port);
      resolve(port);
    });
    srv.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries > 0) {
        srv.close();
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

module.exports = { app, start, modules, settings };

if (require.main === module) {
  start().catch((e) => {
    console.error('启动失败:', e.message);
    process.exit(1);
  });
}

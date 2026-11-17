#!/usr/bin/env node
/**
 * TikTok Scraper 插件 · MCP 服务（零依赖，独立运行）
 *
 * 不装浏览器、不装 npm 依赖、不需要桌面应用：
 *   抓取交给 Claude 自带的浏览器（内置浏览器 / Claude in Chrome）执行 browser/collect.js，
 *   这里负责：规划区间 → 收数据 → 统计（周期对比、挂车对比、发布时段、TOP）→ 导出 Excel / CSV → 历史。
 * 统计口径与桌面应用完全相同（共用 lib/jobs.js、lib/report.js、public/shared/*）。
 *
 * 协议：MCP stdio（JSON-RPC 2.0，按行分隔）。stdout 只输出协议消息，日志走 stderr。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const pkg = (() => {
  try {
    return require(path.join(ROOT, 'package.json'));
  } catch (_) {
    return require(path.join(ROOT, '.claude-plugin', 'plugin.json'));
  }
})();
const { createJobStore, buildJob, JobError } = require('../lib/jobs');
const report = require('../lib/report');
const { buildLiteWorkbook } = require('../lib/report-lite');
const ingest = require('../lib/browser-ingest');
const TTPeriod = require('../public/shared/period.js');

/* ---------------- 数据目录：有桌面应用就和它共用历史，否则 ~/.tiktok-scraper ---------------- */
function baseDir() {
  if (process.env.TT_BASE_DIR) return process.env.TT_BASE_DIR;
  const home = os.homedir();
  const roots =
    process.platform === 'win32'
      ? [process.env.APPDATA || path.join(home, 'AppData', 'Roaming')]
      : process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support')]
      : [process.env.XDG_CONFIG_HOME || path.join(home, '.config')];
  for (const r of roots) for (const n of ['TikTokScraper', 'tiktok-scraper']) if (fs.existsSync(path.join(r, n, 'data', 'jobs'))) return path.join(r, n);
  return path.join(home, '.tiktok-scraper');
}
const BASE = baseDir();
const store = createJobStore({
  dataDir: path.join(BASE, 'data', 'jobs'),
  scraper: { scrapeMany: async () => { throw new Error('插件模式由浏览器采集，不在本进程抓取'); } },
  report,
  videodb: null,
  log: (m) => process.stderr.write(`[tiktok-scraper] ${m}\n`),
});

/* ---------------- 采集脚本：去掉注释和缩进，省 token ---------------- */
let SCRIPT = null;
function collectorScript() {
  if (SCRIPT) return SCRIPT;
  const src = fs.readFileSync(path.join(ROOT, 'browser', 'collect.js'), 'utf8');
  SCRIPT = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s+/, '').replace(/\s+\/\/ .*$/, ''))
    .filter((l) => l && !l.startsWith('//'))
    .join('\n');
  return SCRIPT;
}

const COMPARE = { none: 'none', previous: 'previous', lastweek: 'lastWeek', lastmonth: 'lastMonth', custom: 'custom', 上周: 'lastWeek', 上月同期: 'lastMonth', 上一周期: 'previous', 不对比: 'none' };
const norm = (v) => (v ? COMPARE[String(v).replace(/[\s_-]/g, '').toLowerCase()] || String(v) : undefined);
const sleepUntilFinished = (job) => store.isFinished(job);

function latest(finishedOnly) {
  const j = store.list(50).find((x) => !finishedOnly || x.status === 'done' || x.status === 'stopped');
  if (!j) throw new Error('还没有抓取任务，请先调用 prepare_scrape');
  return j.id;
}

/** 收尾：所有账号都交了数据 → 任务完成，返回分析摘要 */
async function finalize(job, opts = {}) {
  const sub = job.browser.submitted;
  job.results = job.handles.map((h) => {
    const r = sub[h];
    if (!r) return { handle: h, nickname: '', stats: {}, items: [], complete: false, oldestDate: null, error: '没有采集到数据' };
    return r;
  });
  job.rowCount = report.toRows(job.results).length;
  const failed = job.results.filter((r) => r.error).length;
  job.status = failed === job.results.length ? 'error' : 'done';
  job.stage = job.status;
  if (job.status === 'error') job.error = '所有账号都没有采集到数据';
  for (const a of job.accounts) {
    const r = sub[a.handle];
    a.state = r && !r.error ? 'done' : 'failed';
    a.count = r ? (r.items || []).length : 0;
    a.complete = r ? r.complete : false;
    a.error = r ? r.error || '' : '没有采集到数据';
  }
  job.finishedAt = new Date().toISOString();
  store.save(job);
  return store.summarize(job, opts);
}

/* ---------------- 工具 ---------------- */
const TOOLS = [
  {
    name: 'prepare_scrape',
    description:
      '第 1 步：规划一次 TikTok 账号抓取（本期 + 对比期），返回任务 ID、需要采集的日期区间和浏览器采集脚本。' +
      '之后用 Claude 的浏览器（内置浏览器优先，其次 Claude in Chrome）打开 https://www.tiktok.com ，用 javascript_tool 先执行脚本，再对每个账号反复执行 await TTC({handle, from, to}) 直到 status=done，把结果交给 submit_account。',
    inputSchema: {
      type: 'object',
      properties: {
        handles: { type: 'array', items: { type: 'string' }, description: 'TikTok 用户名，可带 @，最多 20 个' },
        preset: { type: 'string', enum: TTPeriod.PRESETS, description: '快捷日期（曼谷时间）；和 from/to 二选一，都不填默认本月' },
        from: { type: 'string', description: '开始日期 YYYY-MM-DD' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD，不能晚于今天' },
        compare: {
          type: 'string',
          enum: TTPeriod.COMPARE_MODES,
          description: '对比期：none / previous 上一周期（等长紧邻）/ lastWeek 上周（上一周的相同几天，区间需 ≤7 天）/ lastMonth 上月同期（严格同日期，缺的日期取月末）/ custom',
        },
        compare_from: { type: 'string' },
        compare_to: { type: 'string' },
        include_script: { type: 'boolean', description: '是否返回采集脚本，默认 true；同一对话里已经注入过脚本可传 false 省 token' },
      },
      required: ['handles'],
    },
  },
  {
    name: 'submit_account',
    description:
      '第 2 步：把一个账号的浏览器采集结果交进来（TTC 返回 status=done 的那个对象，原样传 fields / items / profile / complete / oldestDate）。' +
      '采集失败就传 error。所有账号都交齐后自动统计，直接返回分析摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        handle: { type: 'string' },
        fields: { type: 'array', items: { type: 'string' } },
        items: { type: 'array', items: { type: 'array' }, description: 'TTC 返回的 items 二维数组' },
        profile: { type: 'object' },
        complete: { type: 'boolean', description: 'TTC 返回的 complete：是否已经加载到起始日期之前' },
        oldestDate: { type: 'string' },
        error: { type: 'string', description: '采集失败时的原因' },
        cart_mode: { type: 'string', enum: ['mean', 'trim'] },
      },
      required: ['job_id', 'handle'],
    },
  },
  {
    name: 'get_report',
    description: '读取任务的分析摘要：汇总、各账号、本期 vs 对比期、挂车 vs 非挂车（条均 / 剔除最高最低）、最佳发布时段、TOP 视频。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '不填取最近一个已完成任务' },
        cart_mode: { type: 'string', enum: ['mean', 'trim'], description: '挂车对比口径，默认条均；trim = 每个指标去掉最高最低后再比（样本 <3 条自动回退条均）' },
        top: { type: 'integer', minimum: 1, maximum: 30 },
      },
    },
  },
  {
    name: 'list_videos',
    description: '列出任务的视频明细（排序、只看挂车、本期 / 对比期），用于找爆款或核对单条数据。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        period: { type: 'string', enum: ['current', 'compare', 'all'] },
        sort: { type: 'string', enum: ['views', 'likes', 'comments', 'shares', 'saves', 'engagement', 'date'] },
        cart_only: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: 'export_report',
    description: '导出 Excel（汇总对比 / 账号 / 视频明细 / 挂车对比 / 发布时段）或 CSV，返回文件路径。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        format: { type: 'string', enum: ['xlsx', 'csv'] },
        path: { type: 'string', description: '保存路径（可选，默认「下载」文件夹或当前目录）' },
        lang: { type: 'string', enum: ['zh', 'th', 'en'] },
      },
    },
  },
  {
    name: 'list_scrapes',
    description: '历史抓取任务（有桌面应用时和应用共用历史）。',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } },
  },
];

function videosOf(rows, a) {
  const M = require('../public/shared/metrics.js');
  const want = a.period || 'current';
  let list = rows.filter((r) => (a.cart_only ? r.isEC : true) && (want === 'all' ? true : want === 'compare' ? M.inCompare(r) : M.inCurrent(r)));
  const key = { views: 'views', likes: 'likes', comments: 'comments', shares: 'shares', saves: 'saves', engagement: 'inter', date: 'date' }[a.sort] || 'views';
  list = list.sort((x, y) => (y[key] > x[key] ? 1 : y[key] < x[key] ? -1 : 0)).slice(0, Math.min(200, a.limit || 20));
  return list.map((r) => ({
    account: r.account,
    date: `${r.date} ${r.time}`,
    views: r.views,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    saves: r.saves,
    engagementRate: +((r.inter || 0) * 100).toFixed(2),
    cart: r.isEC,
    caption: (r.desc || '').slice(0, 60),
    url: r.url,
  }));
}

function outPath(name, p) {
  if (p) return path.resolve(p);
  const dl = path.join(os.homedir(), 'Downloads');
  return path.join(fs.existsSync(dl) ? dl : process.cwd(), name);
}

const handlers = {
  async prepare_scrape(a) {
    const job = buildJob({
      handles: a.handles,
      preset: a.preset,
      from: a.from,
      to: a.to,
      compareMode: norm(a.compare),
      compareFrom: a.compare_from,
      compareTo: a.compare_to,
      source: 'plugin',
    });
    job.status = 'collecting';
    job.stage = 'collecting';
    job.startedAt = job.createdAt;
    job.browser = { submitted: {} };
    store.adopt(job);
    const out = {
      job_id: job.id,
      handles: job.handles,
      collect: { from: job.from, to: job.to }, // 本期 ∪ 对比期，一次采集
      current: { from: job.currentFrom, to: job.currentTo },
      compare: job.compareFrom ? { mode: job.compareMode, from: job.compareFrom, to: job.compareTo } : null,
      steps: [
        '浏览器打开 https://www.tiktok.com （页面空白就刷新一次；浏览器面板收起也能采集）',
        include(a) ? 'javascript_tool 执行下面的 script（注入 TTC）' : '本对话已注入过 TTC；页面刷新过就重新调用 prepare_scrape 取脚本',
        `每个账号：反复执行 await TTC({handle:'账号', from:'${job.from}', to:'${job.to}'})，status=running 时继续调用（每次约 25 秒），直到 status=done`,
        `把 done 的结果交给 submit_account(job_id="${job.id}", handle, fields, items, profile, complete, oldestDate)；失败就传 error`,
      ],
    };
    if (include(a)) out.script = collectorScript();
    return out;
  },

  async submit_account(a) {
    const job = store.get(a.job_id);
    if (!job) throw new Error(`任务不存在：${a.job_id}`);
    if (!job.browser) throw new Error('这个任务不是浏览器采集任务');
    const h = String(a.handle || '').replace(/^@/, '').trim();
    if (!job.handles.includes(h)) throw new Error(`任务里没有这个账号：@${h}（应为 ${job.handles.map((x) => '@' + x).join(' ')}）`);
    const items = a.error ? [] : ingest.toRawItems(a.fields, a.items);
    job.browser.submitted[h] = {
      handle: h,
      nickname: (a.profile && a.profile.nickname) || '',
      stats: ingest.toStats(a.profile),
      items,
      complete: a.error ? false : a.complete !== false,
      oldestDate: a.oldestDate || null,
      error: a.error ? String(a.error).slice(0, 300) : '',
    };
    const acc = job.accounts.find((x) => x.handle === h);
    if (acc) Object.assign(acc, { state: a.error ? 'failed' : 'done', count: items.length });
    store.save(job);
    const left = job.handles.filter((x) => !job.browser.submitted[x]);
    if (left.length) return { job_id: job.id, received: `@${h} ${items.length} 条`, remaining: left.map((x) => '@' + x) };
    return finalize(job, { cartMode: a.cart_mode });
  },

  async get_report(a) {
    const id = a.job_id || latest(true);
    const job = store.get(id);
    if (!job) throw new Error(`任务不存在：${id}`);
    if (!sleepUntilFinished(job)) {
      const left = job.browser ? job.handles.filter((x) => !job.browser.submitted[x]) : job.handles;
      return { job_id: id, status: job.status, waitingFor: left.map((x) => '@' + x) };
    }
    return store.summarize(job, { cartMode: a.cart_mode, top: a.top });
  },

  async list_videos(a) {
    const id = a.job_id || latest(true);
    const job = store.get(id);
    if (!job) throw new Error(`任务不存在：${id}`);
    return { job_id: id, videos: videosOf(await store.rowsOf(job), a) };
  },

  async export_report(a) {
    const id = a.job_id || latest(true);
    const job = store.get(id);
    if (!job) throw new Error(`任务不存在：${id}`);
    if (!store.isFinished(job)) throw new Error('任务还没完成');
    const lang = a.lang || 'zh';
    const rows = await store.rowsOf(job);
    if (!rows.length) throw new Error('该区间内没有数据');
    const base = `tiktok_${job.handles.join('_').slice(0, 40)}_${job.currentFrom}_${job.currentTo}`;
    if (a.format === 'csv') {
      const file = outPath(`${base}.csv`, a.path);
      fs.writeFileSync(file, '﻿' + report.buildCsv(rows, lang, !!job.compareFrom));
      return { file };
    }
    let buf;
    try {
      // 装了 exceljs（完整版仓库）就用和桌面应用一样的完整报表
      if (process.env.TT_XLSX_LITE === '1') throw new Error('lite');
      require.resolve('exceljs');
      buf = (await store.exportXlsx(job, lang)).buffer;
    } catch (_) {
      buf = buildLiteWorkbook({ summary: await store.summarize(job, {}), rows, ranges: store.ranges(job), lang });
    }
    const file = outPath(`${base}.xlsx`, a.path);
    fs.writeFileSync(file, buf);
    return { file };
  },

  async list_scrapes(a) {
    return store.list(a.limit || 10).map((j) => ({
      id: j.id,
      status: j.status,
      handles: j.handles,
      current: `${j.currentFrom} ~ ${j.currentTo}`,
      compare: j.compareFrom ? `${j.compareFrom} ~ ${j.compareTo}` : undefined,
      videos: j.rowCount,
      source: j.source,
    }));
  },
};
const include = (a) => a.include_script !== false;

/* ---------------- JSON-RPC over stdio ---------------- */
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
async function onMessage(m) {
  const { id, method, params = {} } = m;
  const isReq = id !== undefined && id !== null;
  try {
    if (method === 'initialize')
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'tiktok-scraper', title: 'TikTok Scraper', version: pkg.version },
          instructions:
            'TikTok 账号数据抓取与分析。流程：prepare_scrape → 用 Claude 的浏览器在 tiktok.com 执行返回的脚本、对每个账号调用 TTC 直到 done → submit_account（交齐后自动出分析）→ 需要时 list_videos / export_report。没数据就刷新页面、重新执行脚本再试。',
        },
      });
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'resources/list') return send({ jsonrpc: '2.0', id, result: { resources: [] } });
    if (method === 'prompts/list') return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
    if (method === 'tools/call') {
      const h = handlers[params.name];
      if (!h) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具：${params.name}` } });
      try {
        const out = await h(params.arguments || {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
      } catch (e) {
        const msg = e instanceof JobError || e instanceof Error ? e.message : String(e);
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `出错：${msg}` }], isError: true } });
      }
    }
    if (isReq) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${method}` } });
  } catch (e) {
    if (isReq) send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message || String(e) } });
  }
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch (_) {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
  }
  (Array.isArray(m) ? m : [m]).forEach(onMessage);
});
rl.on('close', () => process.exit(0));
process.stderr.write(`[tiktok-scraper] 插件 MCP 已启动 v${pkg.version} · 数据目录 ${BASE}\n`);

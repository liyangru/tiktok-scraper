/**
 * 命令行 / MCP 插件共用的动作层：参数整理 → 任务库 → 精简结果
 * 输出只保留结论需要的字段，省 token。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const rt = require('./runtime');

const STAGE_ZH = {
  init: '准备中',
  queued: '排队中',
  browser: '启动浏览器',
  launch: '启动浏览器',
  open: '打开主页',
  profile: '读取主页',
  scroll: '滚动加载视频',
  filter: '筛选日期',
  save: '保存结果',
  stats: '统计中',
  done: '完成',
  stopped: '已停止',
  stopping: '正在停止',
  error: '出错',
};

const COMPARE_ALIASES = {
  none: 'none', no: 'none', '不对比': 'none',
  previous: 'previous', prev: 'previous', '上一周期': 'previous', '环比': 'previous',
  lastweek: 'lastWeek', '上周同期': 'lastWeek',
  lastmonth: 'lastMonth', mom: 'lastMonth', '上月同期': 'lastMonth', '月同期': 'lastMonth',
  custom: 'custom', '自定义': 'custom',
};
const PRESET_ALIASES = {
  today: 'today', '今天': 'today',
  yesterday: 'yesterday', '昨天': 'yesterday',
  thisweek: 'thisWeek', '本周': 'thisWeek',
  lastweek: 'lastWeek', '上周': 'lastWeek',
  thismonth: 'thisMonth', '本月': 'thisMonth',
  lastmonth: 'lastMonth', '上月': 'lastMonth',
  last7: 'last7', '7d': 'last7', '最近7天': 'last7',
  last30: 'last30', '30d': 'last30', '最近30天': 'last30',
  last90: 'last90', '90d': 'last90', '最近90天': 'last90',
  all: 'all', '全部': 'all',
};
const norm = (map, v) => (v === undefined || v === null || v === '' ? undefined : map[String(v).replace(/[\s_-]/g, '').toLowerCase()] || String(v));

class NotReady extends Error {}

/** 依赖 / 浏览器没就绪时，自动开始安装并告诉调用方稍后再试 */
async function ensureReady() {
  if (!rt.depsReady()) {
    rt.installDeps().catch((e) => process.stderr.write(`[tiktok-scraper] 依赖安装失败：${e.message}\n`));
    throw new NotReady('首次使用：正在后台安装运行依赖（约 1 分钟），请稍后再调用。可用 doctor 查看进度。');
  }
  if (!rt.findBrowser()) {
    if (!rt.isBrowserInstalling()) rt.installBrowser().catch((e) => process.stderr.write(`[tiktok-scraper] 浏览器下载失败：${e.message}\n`));
    throw new NotReady('首次使用：正在后台下载抓取用浏览器（约 170MB，只需一次），请 1–3 分钟后再调用。可用 doctor 查看进度。');
  }
  return rt.getStore();
}

function startParams(a) {
  return {
    handles: a.handles,
    preset: norm(PRESET_ALIASES, a.preset),
    from: a.from,
    to: a.to,
    compareMode: norm(COMPARE_ALIASES, a.compare),
    compareFrom: a.compare_from || a.compareFrom,
    compareTo: a.compare_to || a.compareTo,
    source: a.source || 'agent',
  };
}

/** 进行中的任务：一行状态 + 每个账号进度 */
function progress(job) {
  const secs = job.startedAt ? Math.round((Date.now() - Date.parse(job.startedAt)) / 1000) : 0;
  return {
    id: job.id,
    status: job.status,
    stage: STAGE_ZH[job.stage] || job.stage || '',
    elapsedSec: secs,
    accounts: (job.accounts || []).map((x) => ({
      handle: x.handle,
      state: x.state,
      stage: STAGE_ZH[x.stage] || x.stage || undefined,
      found: x.found || undefined,
      count: x.count || undefined,
      error: x.error || undefined,
    })),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等任务结束（最多 waitSec 秒）；结束了就给摘要，否则给进度 */
async function waitFor(store, id, waitSec, opts = {}) {
  const deadline = Date.now() + Math.max(0, waitSec || 0) * 1000;
  let job = store.get(id);
  if (!job) throw new Error(`任务不存在：${id}`);
  while (!store.isFinished(job) && !['error', 'stopped'].includes(job.status) && Date.now() < deadline) {
    if (opts.onTick) opts.onTick(job);
    await sleep(1000);
    job = store.get(id);
  }
  if (store.isFinished(job)) return { finished: true, summary: await store.summarize(job, opts) };
  if (['error', 'stopped'].includes(job.status)) return { finished: true, summary: { id, status: job.status, error: job.error || undefined } };
  return { finished: false, progress: progress(job) };
}

function defaultExportPath(name) {
  const dl = path.join(os.homedir(), 'Downloads');
  const dir = fs.existsSync(dl) ? dl : process.cwd();
  return path.join(dir, name);
}

async function exportFile(store, id, format = 'xlsx', out, lang = 'zh') {
  const job = store.get(id);
  if (!job) throw new Error(`任务不存在：${id}`);
  if (!store.isFinished(job)) throw new Error('任务还没完成，完成后才能导出');
  let file;
  if (format === 'csv') {
    const r = await store.exportCsv(job, lang);
    file = out ? path.resolve(out) : defaultExportPath(r.name);
    fs.writeFileSync(file, '﻿' + r.text);
  } else {
    const r = await store.exportXlsx(job, lang);
    file = out ? path.resolve(out) : defaultExportPath(r.name);
    fs.writeFileSync(file, r.buffer);
  }
  return file;
}

/** 视频明细（按播放排序，截断文案，省 token） */
async function videos(store, id, { period = 'current', sort = 'views', limit = 20, cartOnly = false } = {}) {
  const job = store.get(id);
  if (!job) throw new Error(`任务不存在：${id}`);
  const rows = await store.rowsOf(job);
  const want = period === 'all' ? null : period === 'compare' ? 'compare' : 'current';
  let list = rows.filter((r) => {
    if (cartOnly && !r.isEC) return false;
    if (!want) return true;
    const m = require('../public/shared/metrics.js');
    return want === 'compare' ? m.inCompare(r) : m.inCurrent(r);
  });
  const key = { views: 'views', likes: 'likes', engagement: 'inter', date: 'date', shares: 'shares', saves: 'saves', comments: 'comments' }[sort] || 'views';
  list = list.sort((a, b) => (b[key] > a[key] ? 1 : b[key] < a[key] ? -1 : 0)).slice(0, Math.min(200, limit || 20));
  return list.map((r) => ({
    account: r.account,
    date: `${r.date} ${r.time || ''}`.trim(),
    views: r.views,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    saves: r.saves,
    engagementRate: +((r.inter || 0) * 100).toFixed(2),
    cart: !!r.isEC,
    caption: (r.desc || '').slice(0, 80),
    url: r.url,
  }));
}

module.exports = { rt, ensureReady, NotReady, startParams, progress, waitFor, exportFile, videos, STAGE_ZH, PRESET_ALIASES, COMPARE_ALIASES };

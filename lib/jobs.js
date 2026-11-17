/**
 * 抓取任务：建任务 / 执行 / 停止 / 结果视图 / 导出 / 摘要
 *
 * 桌面应用（server.js）、命令行（bin/cli.js）、MCP 插件（mcp/server.js）共用这一份，
 * 三种用法的口径完全一致：同一套对比区间算法（public/shared/period.js）
 * 和同一套指标算法（public/shared/metrics.js）。
 *
 * 任务 JSON 存在 <dataDir>/<id>.json：桌面应用和插件指向同一个目录时，彼此能看到对方的历史。
 */
const fs = require('fs');
const path = require('path');
const TTPeriod = require('../public/shared/period.js');
const TTMetrics = require('../public/shared/metrics.js');

class JobError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const RUNNING = ['queued', 'running', 'stopping'];
/** 运行期才有的字段（AbortController 等）不落盘 */
const RUNTIME_KEYS = new Set(['abort']);

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

/** 浏览器引擎的原始报错带终端颜色码和整段调用日志，只保留给人看的第一句 */
function cleanErr(m) {
  return String(m || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\n|Call log:/)[0]
    .replace(/^page\.goto:\s*/, '')
    .replace(/net::ERR_[A-Z_]+/, (x) => `网络连接失败（${x}）`)
    .trim()
    .slice(0, 200);
}

/** job 的期次区间（兼容旧 job：缺字段就退化成「只有本期」） */
function jobRanges(job) {
  return {
    currentFrom: job.currentFrom || job.from,
    currentTo: job.currentTo || job.to,
    compareFrom: job.compareFrom || null,
    compareTo: job.compareTo || null,
  };
}

/** 每个账号真正加载到了多早的数据：对比期早于这个日期的部分属于「数据不足」 */
function jobCoverage(job) {
  return (job.results || []).map((r) => ({
    handle: r.handle,
    complete: r.complete !== false,
    from: r.complete === false ? r.oldestDate || job.to : job.from,
    to: job.to,
    error: r.error || '',
  }));
}

/**
 * 把调用参数规整成一个任务定义。
 * 入参：{ handles, from, to, preset, compareMode, compareFrom, compareTo }
 *   preset 优先于 from/to（today / yesterday / thisWeek / lastWeek / thisMonth / lastMonth / last7 / last30 / last90 / all）
 */
function buildJob(body) {
  const b = body || {};
  const raw = Array.isArray(b.handles) ? b.handles : String(b.handles || '').split(/[\n,，;；\s]+/);
  const handles = [...new Set(raw.map(cleanHandle).filter(Boolean))];
  if (!handles.length) throw new JobError(400, '请至少填写一个 TikTok 用户名');
  if (handles.length > 20) throw new JobError(400, '单次最多 20 个账号');
  for (const h of handles) {
    if (!/^[A-Za-z0-9._]{2,40}$/.test(h)) throw new JobError(400, `用户名格式不对: ${h}`);
  }

  const today = TTPeriod.today();
  let currentFrom = b.from;
  let currentTo = b.to;
  if (b.preset) {
    const r = TTPeriod.presetRange(b.preset, today);
    if (!r) throw new JobError(400, `未知的快捷日期：${b.preset}`);
    currentFrom = r.from;
    currentTo = r.to;
  }
  currentTo = currentTo || today;
  currentFrom = currentFrom || TTPeriod.monthStart(currentTo);
  if (!TTPeriod.isValid(currentFrom) || !TTPeriod.isValid(currentTo)) throw new JobError(400, `日期格式不对：${currentFrom} ~ ${currentTo}`);
  if (currentFrom > currentTo) throw new JobError(400, '起始日期不能晚于结束日期');
  if (currentTo > today) throw new JobError(400, `结束日期不能晚于今天（${today}）`);

  // 兼容旧调用方：只传了 compareFrom/compareTo 没传模式 → 视为自定义
  let compareMode = String(b.compareMode || '');
  if (!compareMode) compareMode = b.compareFrom && b.compareTo ? 'custom' : 'none';
  if (!TTPeriod.COMPARE_MODES.includes(compareMode)) throw new JobError(400, `未知的对比方式：${compareMode}`);
  let cmp = null;
  if (compareMode !== 'none') {
    cmp = TTPeriod.compareRange(compareMode, currentFrom, currentTo, { from: b.compareFrom, to: b.compareTo });
    if (!cmp) {
      if (TTPeriod.isAll(currentFrom)) compareMode = 'none'; // 「全部」没有上一期可比
      else throw new JobError(400, '对比区间无效：请检查自定义对比的起止日期');
    }
  }
  // 两期允许重叠（如本期 14 天选「上周同期」）：重叠日期内的视频同时计入两期、各自统计

  return {
    id: newId(),
    createdAt: new Date().toISOString(),
    status: 'queued',
    source: b.source || 'app',
    handles,
    // 抓取区间 = 本期 ∪ 对比期，出结果后再按期切分
    from: cmp && cmp.from < currentFrom ? cmp.from : currentFrom,
    to: cmp && cmp.to > currentTo ? cmp.to : currentTo,
    currentFrom,
    currentTo,
    compareFrom: cmp ? cmp.from : null,
    compareTo: cmp ? cmp.to : null,
    compareMode: cmp ? compareMode : 'none',
    compareInfo: cmp
      ? { shiftedWeek: cmp.shiftedWeek, fullMonth: cmp.fullMonth, clamped: cmp.clamped, overlapDays: cmp.overlapDays, sameSpan: cmp.sameSpan }
      : null,
    concurrency: 1, // 抓取并发固定为 1（实测并发会显著提高失败率）
    stage: 'init',
    startedAt: null,
    events: [],
    accounts: handles.map((h) => ({ handle: h, state: 'queued', stage: '', found: 0, count: 0, attempt: 0, error: '' })),
    error: null,
    finishedAt: null,
  };
}

/**
 * @param {object} o
 *   dataDir     任务 JSON 目录
 *   scraper / report / videodb   核心库（由调用方注入，方便插件按需加载）
 *   maxScrolls  每个账号最多滚动次数
 *   applySync   (rows, ranges, job) => Promise —— 合并创作中心 / 卖家中心数据（插件里可以不传）
 *   log         日志函数
 */
function createJobStore(o) {
  const dataDir = o.dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  const log = o.log || (() => {});
  const applySync = o.applySync || (async (rows) => rows);
  const jobs = new Map();
  const seen = new Map(); // 文件 → mtime（发现别的进程新建的任务）
  let chain = Promise.resolve(); // 同一进程内任务排队执行：同一时间只开一个浏览器

  const fileOf = (id) => path.join(dataDir, `${id}.json`);
  function save(job) {
    fs.writeFileSync(fileOf(job.id), JSON.stringify(job, (k, v) => (RUNTIME_KEYS.has(k) ? undefined : v)));
    try {
      seen.set(`${job.id}.json`, fs.statSync(fileOf(job.id)).mtimeMs);
    } catch (_) {}
  }

  /** 读盘：首次全部载入；之后只补别的进程（桌面应用 / 插件）新写的任务 */
  function scan(first) {
    let files = [];
    try {
      files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'));
    } catch (_) {
      return;
    }
    for (const f of files) {
      let mt = 0;
      try {
        mt = fs.statSync(path.join(dataDir, f)).mtimeMs;
      } catch (_) {
        continue;
      }
      const id = f.slice(0, -5);
      const mine = jobs.get(id);
      if (mine && (mine.abort || RUNNING.includes(mine.status))) continue; // 本进程正在跑的以内存为准
      if (seen.get(f) === mt) continue;
      seen.set(f, mt);
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
        // 首次载入时还在「运行中」的任务，说明上次进程在抓取中退出：明确标成「已中断」，否则会一直显示加载中
        if (first && RUNNING.includes(j.status)) {
          j.status = 'interrupted';
          j.error = j.error || '应用在任务进行中退出，任务已中断';
          j.finishedAt = j.finishedAt || new Date().toISOString();
          for (const a of j.accounts || []) if (['running', 'retrying', 'queued'].includes(a.state)) a.state = 'stopped';
          try {
            save(j);
          } catch (_) {}
        }
        jobs.set(j.id, j);
      } catch (_) {}
    }
    for (const id of [...jobs.keys()]) {
      const j = jobs.get(id);
      if (!files.includes(`${id}.json`) && !RUNNING.includes(j.status)) jobs.delete(id);
    }
  }
  scan(true);

  function get(id) {
    if (!jobs.has(id)) scan(false);
    return jobs.get(id) || null;
  }

  function list(limit = 50) {
    scan(false);
    return [...jobs.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map((j) => {
        const rg = jobRanges(j);
        return {
          id: j.id,
          status: j.status,
          handles: j.handles,
          from: j.from,
          to: j.to,
          ...rg,
          compareMode: j.compareMode || (rg.compareFrom ? 'custom' : 'none'),
          createdAt: j.createdAt,
          finishedAt: j.finishedAt || null,
          error: j.error || '',
          rowCount: j.rowCount || 0,
          source: j.source || 'app',
        };
      });
  }

  /** 建任务并排队执行；立即返回任务对象 */
  function create(body) {
    const job = buildJob(body);
    jobs.set(job.id, job);
    save(job);
    chain = chain.then(() => run(job)).catch(() => {});
    return job;
  }

  /**
   * 执行抓取。job.stage / accounts[].stage 只在真实执行到对应步骤时更新（来自 scraper 的 stage 事件），
   * 界面据此显示「正在启动浏览器 / 打开主页 / 滚动加载…」，不做凭空推算的进度。
   */
  async function run(job) {
    if (job.status !== 'queued') return; // 排队期间已被停止
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.abort = new AbortController();
    save(job);

    const acc = (h) => job.accounts.find((x) => x.handle === h);
    const push = (ev) => {
      if (ev.reason) ev.reason = cleanErr(ev.reason);
      if (ev.error) ev.error = cleanErr(ev.error);
      job.events.push({ t: Date.now(), ...ev });
      if (job.events.length > 500) job.events.splice(0, job.events.length - 500);
      const a = ev.handle ? acc(ev.handle) : null;
      switch (ev.type) {
        case 'stage':
          if (a) a.stage = ev.stage;
          job.stage = job.status === 'stopping' ? 'stopping' : ev.stage;
          break;
        case 'account-start':
          if (a) Object.assign(a, { state: 'running', attempt: ev.attempt || 1, error: '' });
          job.current = ev.handle;
          break;
        case 'account-retry':
          if (a) Object.assign(a, { state: 'retrying', attempt: (ev.attempt || 1) + 1, error: ev.reason || '' });
          break;
        case 'account-progress':
          if (a && typeof ev.found === 'number') a.found = ev.found;
          break;
        case 'account-error':
          if (a) Object.assign(a, { state: 'failed', error: ev.error || '' });
          break;
        case 'account-done':
          if (a) {
            a.state = ev.error ? 'failed' : 'done';
            if (!ev.error) a.stage = 'done';
            a.count = ev.count;
            a.stats = ev.stats;
            a.complete = ev.complete !== false;
            if (ev.error) a.error = ev.error;
          }
          break;
        case 'account-stopped':
          if (a && a.state !== 'done' && a.state !== 'failed') a.state = 'stopped';
          break;
      }
    };

    // 抓取期间每 3 秒落一次盘：意外退出后，历史里至少能看到进行到哪一步
    const saver = setInterval(() => {
      try {
        save(job);
      } catch (_) {}
    }, 3000);
    try {
      let results;
      try {
        results = await o.scraper.scrapeMany(job.handles, {
          from: job.from,
          to: job.to,
          concurrency: job.concurrency,
          maxScrolls: o.maxScrolls || 400,
          onEvent: push,
          signal: job.abort.signal,
        });
      } finally {
        clearInterval(saver);
      }
      const stopped = !!results.aborted || job.abort.signal.aborted;
      for (const a of job.accounts) {
        if (['running', 'retrying', 'queued'].includes(a.state)) a.state = stopped ? 'stopped' : 'failed';
      }

      push({ type: 'stage', stage: 'save' });
      job.results = results.map((r) => ({
        handle: r.handle,
        nickname: r.nickname,
        stats: r.stats,
        items: r.items,
        complete: r.complete !== false && !r.error,
        oldestDate: r.oldestDate || null,
        error: cleanErr(r.error),
      }));
      job.rowCount = o.report.toRows(job.results).length;
      save(job);

      push({ type: 'stage', stage: 'stats' });
      // 沉淀进视频数据库（按 vid 去重 + 指标历史），供趋势与 AI 分析使用
      if (o.videodb) {
        try {
          const ing = o.videodb.ingest(job);
          log(`视频库：新增 ${ing.added}，更新 ${ing.updated}`);
        } catch (e) {
          log(`视频库写入失败：${e.message}`);
        }
      }
      job.status = stopped ? 'stopped' : 'done';
      job.stage = job.status;
    } catch (e) {
      job.status = 'error';
      job.stage = 'error';
      job.error = cleanErr(e.message || String(e));
      for (const a of job.accounts) if (['running', 'retrying', 'queued'].includes(a.state)) a.state = 'failed';
    } finally {
      job.finishedAt = new Date().toISOString();
      delete job.abort;
      save(job);
    }
  }

  /** 停止任务：真正中断后台抓取（关闭浏览器），已完成账号的数据保留 */
  function stop(id) {
    const job = get(id);
    if (!job) throw new JobError(404, '任务不存在');
    if (job.status === 'queued') {
      job.status = 'stopped';
      job.stage = 'stopped';
      job.finishedAt = new Date().toISOString();
      for (const a of job.accounts) a.state = 'stopped';
      save(job);
      return job;
    }
    if (job.status !== 'running') return job;
    job.status = 'stopping';
    job.stage = 'stopping';
    if (job.abort) job.abort.abort();
    save(job);
    return job;
  }

  function remove(ids) {
    let n = 0;
    for (const id of ids) {
      const j = jobs.get(id);
      if (j && RUNNING.includes(j.status)) continue; // 进行中的任务先停止再删
      jobs.delete(id);
      try {
        if (fs.existsSync(fileOf(id))) fs.unlinkSync(fileOf(id));
        seen.delete(`${id}.json`);
        n++;
      } catch (_) {}
    }
    return n;
  }

  const isFinished = (job) => !!job.results && !RUNNING.includes(job.status);

  /** 明细行（合并平台数据） */
  async function rowsOf(job) {
    if (!isFinished(job)) return [];
    const ranges = jobRanges(job);
    const rows = o.report.toRows(job.results, ranges);
    await applySync(rows, ranges, job);
    return rows;
  }

  /** 给界面的完整视图（进行中只回进度，轮询要轻） */
  async function view(job) {
    const ranges = jobRanges(job);
    const finished = isFinished(job);
    const rows = finished ? await rowsOf(job) : [];
    return {
      id: job.id,
      status: job.status,
      stage: job.stage || '',
      error: job.error,
      from: job.from,
      to: job.to,
      ...ranges,
      compareMode: job.compareMode || (ranges.compareFrom ? 'custom' : 'none'),
      compareInfo: job.compareInfo || null,
      handles: job.handles,
      current: job.current || '',
      createdAt: job.createdAt,
      startedAt: job.startedAt || job.createdAt,
      finishedAt: job.finishedAt,
      now: new Date().toISOString(),
      accounts: job.accounts || [],
      events: (job.events || []).slice(-80), // 老 job 可能没有 events
      coverage: finished ? jobCoverage(job) : [],
      rows,
      periodCompare: rows.length ? o.report.periodCompare(rows, ranges) : null,
      summary: finished
        ? job.results.map((r) => ({ handle: r.handle, nickname: r.nickname, stats: r.stats, complete: r.complete !== false, error: r.error || '' }))
        : [],
    };
  }

  function rangeLabel(job) {
    const rg = jobRanges(job);
    return rg.compareFrom ? `${rg.currentFrom}~${rg.currentTo}  vs  ${rg.compareFrom}~${rg.compareTo}` : `${job.from} ~ ${job.to}`;
  }
  const exportName = (job, ext, lang) => `tiktok_${job.handles.join('_').slice(0, 40)}_${job.currentFrom || job.from}_${job.currentTo || job.to}_${lang}.${ext}`;

  /** 导出 Excel → { name, buffer } */
  async function exportXlsx(job, lang = 'zh') {
    const rows = await rowsOf(job);
    if (!rows.length) throw new JobError(404, '该区间内没有数据');
    const wb = await o.report.buildWorkbook({
      rows,
      accounts: job.results.map((r) => ({ handle: r.handle, nickname: r.nickname, stats: r.stats })),
      title: `TikTok · ${job.handles.join(' / ')}`,
      rangeLabel: rangeLabel(job),
      ranges: jobRanges(job),
      lang,
    });
    return { name: exportName(job, 'xlsx', lang), buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
  }

  /** 导出 CSV → { name, text } */
  async function exportCsv(job, lang = 'zh') {
    const rows = await rowsOf(job);
    if (!rows.length) throw new JobError(404, '该区间内没有数据');
    return { name: exportName(job, 'csv', lang), text: o.report.buildCsv(rows, lang, !!jobRanges(job).compareFrom) };
  }

  /**
   * 精简摘要（命令行 / 插件用）：本期汇总、按账号、周期对比、挂车对比、TOP 视频、最佳发布时段。
   * 只给结论需要的数字，不带逐条明细，省 token。
   */
  async function summarize(job, opts = {}) {
    const rows = await rowsOf(job);
    const rg = jobRanges(job);
    const cur = rows.filter(TTMetrics.inCurrent);
    const pick = (a) => ({
      videos: a.n,
      views: a.views,
      avgViews: a.avgViews === null ? null : Math.round(a.avgViews),
      medianViews: a.medViews,
      likes: a.likes,
      comments: a.comments,
      shares: a.shares,
      saves: a.saves,
      engagementRate: a.inter === null ? null : +(a.inter * 100).toFixed(2),
      cartShare: a.ecShare === null ? null : +(a.ecShare * 100).toFixed(1),
    });
    const cov = jobCoverage(job);
    const out = {
      id: job.id,
      status: job.status,
      error: job.error || undefined,
      current: { from: rg.currentFrom, to: rg.currentTo, days: TTPeriod.span(rg.currentFrom, rg.currentTo) },
      totals: pick(TTMetrics.aggregate(cur)),
      accounts: (job.results || []).map((r) => ({
        handle: r.handle,
        nickname: r.nickname,
        followers: r.stats && r.stats.followerCount,
        ...pick(TTMetrics.aggregate(cur.filter((x) => x.account === r.handle))),
        error: r.error || undefined,
        incompleteFrom: r.complete === false ? r.oldestDate || null : undefined,
      })),
    };
    if (rg.compareFrom) {
      const need = rg.compareFrom;
      const gaps = cov.filter((c) => !c.error && c.from > need).map((c) => `@${c.handle} ≥ ${c.from}`);
      const pc = TTMetrics.periodCompare(rows, rg);
      out.compare = {
        mode: job.compareMode,
        from: rg.compareFrom,
        to: rg.compareTo,
        days: pc.compareDays,
        sameSpan: pc.sameSpan,
        insufficient: gaps.length ? gaps : undefined,
        notes: [
          job.compareInfo && job.compareInfo.shiftedWeek ? '上周同期为整段平移 7 天，非完整自然周环比' : null,
          job.compareInfo && job.compareInfo.overlapDays ? `两期重叠 ${job.compareInfo.overlapDays} 天` : null,
          pc.sameSpan ? null : '两期天数不同，看日均 / 条均',
        ].filter(Boolean),
        metrics: Object.fromEntries(
          pc.metrics.map((m) => [
            m.key,
            {
              current: m.cur === null ? null : +m.cur.toFixed(m.kind === 'pct' ? 4 : 1),
              compare: gaps.length ? null : m.cmp === null ? null : +m.cmp.toFixed(m.kind === 'pct' ? 4 : 1),
              changePct: gaps.length || m.pct === null ? null : +(m.pct * 100).toFixed(1),
            },
          ])
        ),
      };
    }
    const cc = TTMetrics.cartCompare(cur, opts.cartMode || 'mean');
    if (cc.ec.n && cc.non.n) {
      out.cart = {
        mode: cc.mode,
        cartVideos: cc.ec.n,
        nonCartVideos: cc.non.n,
        fallback: cc.fallback.ec || cc.fallback.non || undefined,
        metrics: Object.fromEntries(
          cc.metrics.map((m) => [
            m.key,
            {
              cart: m.ec.value === null ? null : +m.ec.value.toFixed(m.kind === 'pct' ? 4 : 1),
              nonCart: m.non.value === null ? null : +m.non.value.toFixed(m.kind === 'pct' ? 4 : 1),
              diffPct: m.pct === null ? null : +(m.pct * 100).toFixed(1),
            },
          ])
        ),
      };
    }
    // 发布时段：每个小时发了几条、条均播放（样本 ≥ 2 条才参与「最佳时段」）
    const byHour = {};
    for (const r of cur) {
      const h = Number(String(r.time || '').slice(0, 2));
      if (!Number.isFinite(h)) continue;
      (byHour[h] = byHour[h] || []).push(r.views || 0);
    }
    const hours = Object.entries(byHour)
      .map(([h, v]) => ({ hour: +h, videos: v.length, avgViews: Math.round(v.reduce((s, x) => s + x, 0) / v.length) }))
      .sort((a, b) => a.hour - b.hour);
    out.bestHours = hours.filter((x) => x.videos >= 2).sort((a, b) => b.avgViews - a.avgViews).slice(0, 3);
    out.topVideos = [...cur]
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, opts.top || 5)
      .map((r) => ({
        account: r.account,
        date: r.date,
        views: r.views,
        engagementRate: +((r.inter || 0) * 100).toFixed(2),
        cart: !!r.isEC,
        caption: (r.desc || '').slice(0, 60),
        url: r.url,
      }));
    return out;
  }

  return { get, list, create, stop, save, remove, view, rowsOf, summarize, exportXlsx, exportCsv, isFinished, ranges: jobRanges, RUNNING };
}

module.exports = { createJobStore, buildJob, cleanHandle, cleanErr, jobRanges, jobCoverage, JobError, RUNNING };

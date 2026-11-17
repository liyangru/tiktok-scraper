#!/usr/bin/env node
/**
 * TikTok Scraper 命令行：不开桌面应用直接抓取 / 出报告
 *
 *   tiktok-scraper scrape @a @b --preset thisMonth --compare lastMonth --xlsx
 *   tiktok-scraper list
 *   tiktok-scraper show [任务ID] [--json]
 *   tiktok-scraper export [任务ID] --csv --out ./a.csv
 *   tiktok-scraper doctor | setup
 *   tiktok-scraper mcp          # 以 MCP 服务方式运行（给 Claude Code / Codex 用）
 */

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'help';

if (cmd === 'mcp') {
  require('../mcp/server.js');
  return;
}

const agent = require('../lib/agent');
const { rt } = agent;

function parse(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) o[k] = v;
      else if (args[i + 1] && !args[i + 1].startsWith('--')) o[k] = args[++i];
      else o[k] = true;
    } else o._.push(a);
  }
  return o;
}
const opt = parse(argv);

const fmt = (n) => (n === null || n === undefined ? '—' : typeof n === 'number' ? (Math.abs(n) >= 100 ? Math.round(n) : n).toLocaleString('en-US') : String(n));
const pct = (n) => (n === null || n === undefined ? '' : `${n > 0 ? '▲' : n < 0 ? '▼' : ''}${Math.abs(n)}%`);
const pad = (s, n) => {
  s = String(s);
  const w = [...s].reduce((x, c) => x + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

/** 终端里的简洁摘要 */
function printSummary(s) {
  if (!s.totals) {
    console.log(`任务 ${s.id}：${s.status}${s.error ? ' · ' + s.error : ''}`);
    return;
  }
  const t = s.totals;
  const cm = (s.compare && s.compare.metrics) || {};
  console.log(`\n本期 ${s.current.from} ~ ${s.current.to}（${s.current.days} 天）` + (s.compare ? `   对比 ${s.compare.from} ~ ${s.compare.to}` : ''));
  if (s.compare && s.compare.insufficient) console.log(`⚠ 对比期数据不全：${s.compare.insufficient.join('，')}`);
  const line = (label, v, key) => console.log(`  ${pad(label, 10)}${pad(fmt(v), 14)}${cm[key] ? pct(cm[key].changePct) : ''}`);
  line('视频数', t.videos, 'videos');
  line('总播放', t.views, 'views');
  line('条均播放', t.avgViews, 'avgViews');
  line('互动率', t.engagementRate === null ? null : t.engagementRate + '%', 'inter');
  line('挂车占比', t.cartShare === null ? null : t.cartShare + '%', 'ecShare');
  if (s.accounts.length > 1) {
    console.log('\n账号');
    for (const a of s.accounts) console.log(`  @${pad(a.handle, 24)}${pad(fmt(a.videos) + ' 条', 10)}${pad(fmt(a.views) + ' 播放', 18)}${a.error ? '✗ ' + a.error : ''}`);
  }
  if (s.cart) {
    const v = s.cart.metrics.views || Object.values(s.cart.metrics)[0];
    console.log(`\n挂车 ${s.cart.cartVideos} 条 vs 非挂车 ${s.cart.nonCartVideos} 条：条均播放 ${fmt(v && v.cart)} vs ${fmt(v && v.nonCart)} ${pct(v && v.diffPct)}`);
  }
  if (s.bestHours && s.bestHours.length) console.log(`最佳发布时段：${s.bestHours.map((h) => `${String(h.hour).padStart(2, '0')}:00（条均 ${fmt(h.avgViews)}）`).join('、')}`);
  if (s.topVideos && s.topVideos.length) {
    console.log('\nTOP 视频');
    s.topVideos.forEach((v, i) => console.log(`  ${i + 1}. ${pad(fmt(v.views), 12)}${v.date}  @${v.account}${v.cart ? ' [挂车]' : ''}  ${v.caption}`));
  }
  console.log(`\n任务 ID：${s.id}`);
}

async function ready() {
  if (!rt.depsReady()) {
    console.error('首次使用：安装运行依赖…');
    await rt.installDeps(true);
  }
  if (!rt.findBrowser()) {
    console.error('首次使用：下载抓取用浏览器（约 170MB，只需一次）…');
    await rt.installBrowser(true);
  }
  return rt.getStore();
}

function latestId(store, finishedOnly) {
  const j = store.list(50).find((x) => !finishedOnly || x.status === 'done' || x.status === 'stopped');
  if (!j) throw new Error('还没有抓取任务');
  return j.id;
}

async function main() {
  switch (cmd) {
    case 'scrape': {
      const store = await ready();
      const job = store.create(
        agent.startParams({ handles: opt._, preset: opt.preset, from: opt.from, to: opt.to, compare: opt.compare, compare_from: opt['compare-from'], compare_to: opt['compare-to'], source: 'cli' })
      );
      process.on('SIGINT', () => {
        console.error('\n正在停止…（已抓完的账号会保留）');
        store.stop(job.id);
      });
      let last = '';
      const r = await agent.waitFor(store, job.id, 3600 * 6, {
        cartMode: opt.trim ? 'trim' : 'mean',
        onTick: (j) => {
          const p = agent.progress(j);
          const a = p.accounts.find((x) => x.state === 'running' || x.state === 'retrying');
          const s = `[${p.elapsedSec}s] ${p.stage}${a ? ` · @${a.handle}${a.found ? ` 已发现 ${a.found} 条` : ''}` : ''}`;
          if (s !== last && process.stderr.isTTY) process.stderr.write(`\r${s.padEnd(60)}`);
          last = s;
        },
      });
      if (process.stderr.isTTY) process.stderr.write('\n');
      if (opt.json) console.log(JSON.stringify(r.summary, null, 2));
      else printSummary(r.summary);
      if (opt.xlsx || opt.csv) {
        const file = await agent.exportFile(store, job.id, opt.csv ? 'csv' : 'xlsx', typeof (opt.xlsx || opt.csv) === 'string' ? opt.xlsx || opt.csv : opt.out, opt.lang || 'zh');
        console.log(`已导出：${file}`);
      }
      break;
    }
    case 'list': {
      const store = await ready();
      for (const j of store.list(parseInt(opt.limit || '15', 10))) {
        console.log(`${j.id}  ${pad(j.status, 9)}${pad(j.currentFrom + '~' + j.currentTo, 24)}${pad(fmt(j.rowCount) + ' 条', 9)}@${j.handles.join(' @')}`);
      }
      break;
    }
    case 'show': {
      const store = await ready();
      const id = opt._[0] || latestId(store, true);
      const job = store.get(id);
      if (!job) throw new Error(`任务不存在：${id}`);
      const s = store.isFinished(job) ? await store.summarize(job, { cartMode: opt.trim ? 'trim' : 'mean', top: parseInt(opt.top || '5', 10) }) : agent.progress(job);
      if (opt.json || !s.totals) console.log(JSON.stringify(s, null, 2));
      else printSummary(s);
      break;
    }
    case 'export': {
      const store = await ready();
      const id = opt._[0] || latestId(store, true);
      console.log(await agent.exportFile(store, id, opt.csv ? 'csv' : 'xlsx', opt.out, opt.lang || 'zh'));
      break;
    }
    case 'setup':
      await ready();
      console.log('✓ 环境就绪');
    // fallthrough
    case 'doctor': {
      const d = rt.doctor();
      console.log(`版本      ${d.version}（Node ${d.node}）`);
      console.log(`数据目录  ${d.dataDir}${d.sharedWithDesktopApp ? '（与桌面应用共用）' : ''}`);
      console.log(`依赖      ${d.depsReady ? '✓' : '✗ 运行 tiktok-scraper setup'}`);
      console.log(`浏览器    ${d.browser || '✗ 运行 tiktok-scraper setup'}`);
      break;
    }
    default:
      console.log(`TikTok Scraper ${require('../package.json').version}

用法
  tiktok-scraper scrape <账号...> [--preset thisMonth] [--from 2026-11-01 --to 2026-11-17]
                        [--compare none|previous|lastWeek|lastMonth|custom] [--compare-from --compare-to]
                        [--xlsx [文件]] [--csv [文件]] [--trim] [--json]
  tiktok-scraper list                 历史任务
  tiktok-scraper show [任务ID]         查看摘要（默认最近一个）
  tiktok-scraper export [任务ID] [--csv] [--out 文件] [--lang zh|th|en]
  tiktok-scraper doctor | setup       检查 / 安装依赖和浏览器
  tiktok-scraper mcp                  作为 MCP 服务运行

快捷日期  today yesterday thisWeek lastWeek thisMonth lastMonth last7 last30 last90 all
示例      tiktok-scraper scrape loopearplugs.th --preset thisMonth --compare lastMonth --xlsx`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  });

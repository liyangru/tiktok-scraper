/**
 * 轻量 Excel 报表（插件用，零依赖）：汇总对比 / 账号 / 视频明细 / 挂车对比 / 发布时段
 * 数字全部来自 jobs.summarize 与 report.toRows，和桌面应用口径一致。
 */
const { buildXlsx } = require('./xlsx-lite');
const TTMetrics = require('../public/shared/metrics.js');

const L = {
  zh: {
    s: ['汇总', '账号', '视频明细', '挂车对比', '发布时段'],
    metric: '指标', cur: '本期', cmp: '对比期', chg: '变化', range: '区间',
    m: { videos: '视频数', views: '总播放', likes: '点赞', comments: '评论', shares: '分享', saves: '收藏', reposts: '转发', videosPerDay: '日均发布', viewsPerDay: '日均播放', avgViews: '条均播放', medViews: '中位播放', avgInteractions: '条均互动', inter: '互动率' },
    acc: ['账号', '昵称', '粉丝', '视频数', '总播放', '条均播放', '互动率', '挂车占比', '备注'],
    det: ['账号', '日期', '时间', '期次', '播放', '点赞', '评论', '分享', '收藏', '互动率', '挂车', '时长(秒)', '文案', '链接'],
    per: { current: '本期', compare: '对比期', both: '本期+对比期', other: '' },
    cart: ['指标', '挂车', '非挂车', '挂车比非挂车'],
    cm: { n: '视频数', views: '条均播放', likes: '条均点赞', comments: '条均评论', shares: '条均分享', saves: '条均收藏', inter: '互动率' },
    hrs: ['发布时段', '视频数', '条均播放'],
    yes: '是', note: '说明', insufficient: '对比期数据不全，不下涨跌结论', incomplete: '较早日期可能不完整',
  },
  en: {
    s: ['Summary', 'Accounts', 'Videos', 'Cart vs non-cart', 'Posting hours'],
    metric: 'Metric', cur: 'Current', cmp: 'Compare', chg: 'Change', range: 'Range',
    m: { videos: 'Videos', views: 'Views', likes: 'Likes', comments: 'Comments', shares: 'Shares', saves: 'Saves', reposts: 'Reposts', videosPerDay: 'Videos / day', viewsPerDay: 'Views / day', avgViews: 'Avg views', medViews: 'Median views', avgInteractions: 'Avg interactions', inter: 'Engagement rate' },
    acc: ['Account', 'Name', 'Followers', 'Videos', 'Views', 'Avg views', 'Engagement', 'Cart share', 'Note'],
    det: ['Account', 'Date', 'Time', 'Period', 'Views', 'Likes', 'Comments', 'Shares', 'Saves', 'Engagement', 'Cart', 'Duration (s)', 'Caption', 'Link'],
    per: { current: 'Current', compare: 'Compare', both: 'Both', other: '' },
    cart: ['Metric', 'Cart', 'Non-cart', 'Cart vs non-cart'],
    cm: { n: 'Videos', views: 'Avg views', likes: 'Avg likes', comments: 'Avg comments', shares: 'Avg shares', saves: 'Avg saves', inter: 'Engagement rate' },
    hrs: ['Hour', 'Videos', 'Avg views'],
    yes: 'Yes', note: 'Note', insufficient: 'Compare period incomplete - no change verdict', incomplete: 'Earlier dates may be incomplete',
  },
};
L.th = L.en;

function buildLiteWorkbook({ summary, rows, ranges, lang = 'zh' }) {
  const D = L[lang] || L.zh;
  const pct = (v) => (v === null || v === undefined ? null : { v: v / 100, fmt: 'pct' });
  const sheets = [];

  // 1 汇总
  const sum = { name: D.s[0], columns: [{ header: D.metric, width: 16 }, { header: D.cur, width: 16 }], rows: [] };
  sum.rows.push([D.range, `${ranges.currentFrom} ~ ${ranges.currentTo}`]);
  if (summary.compare) {
    sum.columns.push({ header: D.cmp, width: 16 }, { header: D.chg, width: 12 });
    sum.rows[0].push(`${summary.compare.from} ~ ${summary.compare.to}`, '');
    for (const [k, m] of Object.entries(summary.compare.metrics)) {
      const isPct = k === 'inter';
      sum.rows.push([
        D.m[k] || k,
        isPct ? { v: m.current, fmt: 'pct' } : { v: m.current, fmt: Number.isInteger(m.current) ? 'int' : 'dec' },
        m.compare === null ? null : isPct ? { v: m.compare, fmt: 'pct' } : { v: m.compare, fmt: Number.isInteger(m.compare) ? 'int' : 'dec' },
        pct(m.changePct),
      ]);
    }
    if (summary.compare.insufficient) sum.rows.push([D.note, `${D.insufficient}：${summary.compare.insufficient.join('，')}`]);
    for (const n of summary.compare.notes || []) sum.rows.push([D.note, n]);
  } else {
    const t = summary.totals;
    for (const [k, v] of [['videos', t.videos], ['views', t.views], ['avgViews', t.avgViews], ['likes', t.likes], ['comments', t.comments], ['shares', t.shares], ['saves', t.saves]]) {
      sum.rows.push([D.m[k], { v, fmt: 'int' }]);
    }
    sum.rows.push([D.m.inter, pct(t.engagementRate)]);
  }
  sheets.push(sum);

  // 2 账号
  sheets.push({
    name: D.s[1],
    columns: D.acc.map((h, i) => ({ header: h, width: [22, 22, 10, 9, 12, 11, 10, 10, 30][i], fmt: [null, null, 'int', 'int', 'int', 'int'][i] })),
    rows: summary.accounts.map((a) => [
      '@' + a.handle,
      a.nickname || '',
      a.followers ?? null,
      a.videos,
      a.views,
      a.avgViews,
      pct(a.engagementRate),
      pct(a.cartShare),
      a.error || (a.incompleteFrom !== undefined ? `${D.incomplete}（≥ ${a.incompleteFrom || '?'}）` : ''),
    ]),
  });

  // 3 视频明细（全部行，标注期次）
  const per = (r) => (r.inCurrent && r.inCompare ? D.per.both : r.inCurrent ? D.per.current : r.inCompare ? D.per.compare : D.per.other);
  sheets.push({
    name: D.s[2],
    filter: true,
    columns: D.det.map((h, i) => ({ header: h, width: [20, 11, 7, 10, 11, 9, 8, 8, 8, 9, 6, 9, 50, 14][i], fmt: [null, null, null, null, 'int', 'int', 'int', 'int', 'int'][i] })),
    rows: [...rows]
      .sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1))
      .map((r) => ['@' + r.account, r.date, r.time, per(r), r.views, r.likes, r.comments, r.shares, r.saves, { v: r.inter, fmt: 'pct' }, r.isEC ? D.yes : '', r.duration || null, r.desc, { v: r.url, link: r.url }]),
  });

  // 4 挂车对比
  if (summary.cart) {
    sheets.push({
      name: D.s[3],
      columns: D.cart.map((h, i) => ({ header: h, width: [14, 12, 12, 14][i] })),
      rows: [[D.cm.n, summary.cart.cartVideos, summary.cart.nonCartVideos, null]].concat(
        Object.entries(summary.cart.metrics).map(([k, m]) => {
          const p = k === 'inter';
          return [D.cm[k] || k, p ? { v: m.cart, fmt: 'pct' } : { v: m.cart, fmt: 'dec' }, p ? { v: m.nonCart, fmt: 'pct' } : { v: m.nonCart, fmt: 'dec' }, pct(m.diffPct)];
        })
      ),
    });
  }

  // 5 发布时段（本期）
  const cur = rows.filter(TTMetrics.inCurrent);
  const by = {};
  for (const r of cur) {
    const h = Number(String(r.time || '').slice(0, 2));
    if (!Number.isFinite(h)) continue;
    (by[h] = by[h] || []).push(r.views || 0);
  }
  sheets.push({
    name: D.s[4],
    columns: D.hrs.map((h, i) => ({ header: h, width: [12, 10, 12][i], fmt: [null, 'int', 'int'][i] })),
    rows: Object.keys(by)
      .map(Number)
      .sort((a, b) => a - b)
      .map((h) => [`${String(h).padStart(2, '0')}:00`, by[h].length, Math.round(by[h].reduce((s, x) => s + x, 0) / by[h].length)]),
  });

  return buildXlsx(sheets);
}

module.exports = { buildLiteWorkbook };

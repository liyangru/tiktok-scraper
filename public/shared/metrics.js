/**
 * 指标计算（前后端共用，唯一一份）：汇总、周期对比、挂车 vs 非挂车。
 *
 * 浏览器：window.TTMetrics；Node：require('./public/shared/metrics.js')。
 *
 * 约定（整份文件都遵守）：
 *   - 「没有数据」用 null 表示，「真实的 0」用 0 表示，两者绝不混用。
 *     例：对比期一条视频都没有 → 视频数 = 0（真实的 0），条均播放 = null（无从谈起）。
 *   - 互动率 = 互动总量 ÷ 播放总量（合并口径），不是把每条视频的互动率再取平均 ——
 *     后者会让几十播放的小视频和百万播放的爆款权重一样。
 *   - 变化率的基数为 0 或 null 时返回 null，绝不产生 Infinity / NaN。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TTMetrics = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY = 86400000;

  /** 转成有限数字；null / undefined / '' / NaN 一律视为「没有数据」 */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** 只保留有真实指标的行（搜索框解析链接加进来的行没有播放量，不能当 0 参与计算） */
  const measured = (rows) => (rows || []).filter((r) => num(r.views) !== null);

  const INTERACTION_KEYS = ['likes', 'comments', 'shares', 'saves', 'reposts'];
  const interactionsOf = (r) => INTERACTION_KEYS.reduce((s, k) => s + (num(r[k]) || 0), 0);

  function median(sortedAsc) {
    const n = sortedAsc.length;
    if (!n) return null;
    return n % 2 ? sortedAsc[(n - 1) / 2] : (sortedAsc[n / 2 - 1] + sortedAsc[n / 2]) / 2;
  }

  /** 一组视频的汇总 */
  function aggregate(rows) {
    const list = measured(rows);
    const n = list.length;
    const sum = (k) => list.reduce((s, r) => s + (num(r[k]) || 0), 0);
    const views = sum('views');
    const out = { n, views };
    for (const k of INTERACTION_KEYS) out[k] = sum(k);
    out.interactions = INTERACTION_KEYS.reduce((s, k) => s + out[k], 0);
    const sorted = list.map((r) => num(r.views)).sort((a, b) => a - b);
    out.avgViews = n ? views / n : null;
    out.medViews = median(sorted);
    out.maxViews = n ? sorted[n - 1] : null;
    out.avgInteractions = n ? out.interactions / n : null;
    out.inter = views > 0 ? out.interactions / views : null;
    out.ecN = list.filter((r) => r.isEC).length;
    out.ecShare = n ? out.ecN / n : null;
    return out;
  }

  /** 差值与变化率；任一侧没有数据 → 差值为 null；基数为 0 → 变化率为 null */
  function delta(cur, base) {
    const a = num(cur), b = num(base);
    if (a === null || b === null) return { abs: null, pct: null };
    return { abs: a - b, pct: b === 0 ? null : (a - b) / Math.abs(b) };
  }

  function spanDays(from, to) {
    if (!from || !to) return 0;
    const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
    return Math.round((b - a) / DAY) + 1;
  }

  function bounds(list) {
    let from = null, to = null;
    for (const r of list) {
      if (!r.date) continue;
      if (from === null || r.date < from) from = r.date;
      if (to === null || r.date > to) to = r.date;
    }
    return { from, to };
  }

  const inCurrent = (r) => (r.inCurrent !== undefined ? !!r.inCurrent : r.period !== 'compare' && r.period !== 'other');
  const inCompare = (r) => (r.inCompare !== undefined ? !!r.inCompare : r.period === 'compare');

  /**
   * 周期对比要展示的指标。
   * group: total 总量 / daily 日均（两期天数不同时只有它可比）/ avg 条均 / rate 比率
   * kind:  int 整数 / dec 一位小数 / pct 百分比（差值按百分点展示）
   */
  const PERIOD_METRICS = [
    { key: 'videos', group: 'total', kind: 'int' },
    { key: 'views', group: 'total', kind: 'int' },
    { key: 'likes', group: 'total', kind: 'int' },
    { key: 'comments', group: 'total', kind: 'int' },
    { key: 'shares', group: 'total', kind: 'int' },
    { key: 'saves', group: 'total', kind: 'int' },
    { key: 'reposts', group: 'total', kind: 'int' },
    { key: 'videosPerDay', group: 'daily', kind: 'dec' },
    { key: 'viewsPerDay', group: 'daily', kind: 'int' },
    { key: 'avgViews', group: 'avg', kind: 'int' },
    { key: 'medViews', group: 'avg', kind: 'int' },
    { key: 'avgInteractions', group: 'avg', kind: 'int' },
    { key: 'inter', group: 'rate', kind: 'pct' },
  ];

  function periodSide(list, days) {
    const a = aggregate(list);
    return Object.assign({}, a, bounds(list), {
      days,
      videos: a.n,
      videosPerDay: days ? a.n / days : null,
      viewsPerDay: days ? a.views / days : null,
    });
  }

  /**
   * 本期 vs 对比期。
   * ranges: { currentFrom, currentTo, compareFrom, compareTo }
   * 行上需要有 date，以及 inCurrent / inCompare（由 TTPeriod.classify 打上）。
   */
  function periodCompare(rows, ranges) {
    const r = ranges || {};
    const hasCompare = !!(r.compareFrom && r.compareTo);
    const list = measured(rows);
    const curDays = spanDays(r.currentFrom, r.currentTo);
    const cmpDays = hasCompare ? spanDays(r.compareFrom, r.compareTo) : 0;
    const current = periodSide(list.filter(inCurrent), curDays);
    const compare = periodSide(hasCompare ? list.filter(inCompare) : [], cmpDays);
    const metrics = PERIOD_METRICS.map((m) => {
      const cur = num(current[m.key]);
      const cmp = hasCompare ? num(compare[m.key]) : null;
      return Object.assign({}, m, { cur, cmp }, delta(cur, cmp));
    });
    return {
      hasCompare,
      currentDays: curDays,
      compareDays: cmpDays,
      sameSpan: hasCompare && curDays === cmpDays,
      compareEmpty: hasCompare && compare.n === 0,
      current,
      compare,
      metrics,
    };
  }

  /* ---------------- 挂车 vs 非挂车 ---------------- */
  const CART_METRICS = ['views', 'likes', 'comments', 'shares', 'saves'];
  const CART_MODES = ['mean', 'trim'];
  /** 剔除最高/最低后至少还要剩 1 条，所以一组至少 3 条才剔除 */
  const TRIM_MIN_N = 3;

  /**
   * 一组视频在某个指标上的条均。
   * mode = 'trim'：按**该指标**排序，去掉最高、最低各一条，再对剩下的取平均；
   *               不足 3 条时回退成普通条均并标记 fallback。
   */
  function groupMean(list, key, mode) {
    const vals = list.map((r) => num(r[key])).filter((v) => v !== null).sort((a, b) => a - b);
    const n = vals.length;
    if (!n) return { value: null, n: 0, used: 0, trimmed: false, fallback: false };
    let use = vals, trimmed = false, fallback = false;
    if (mode === 'trim') {
      if (n >= TRIM_MIN_N) { use = vals.slice(1, -1); trimmed = true; } else fallback = true;
    }
    return { value: use.reduce((s, v) => s + v, 0) / use.length, n, used: use.length, trimmed, fallback };
  }

  /**
   * 一组视频的互动率（合并口径：互动总量 ÷ 播放总量）。
   * trim 模式下按**单条互动率**排序去掉最高、最低各一条，再对剩下的视频合并计算。
   * 播放量为 0 的视频没有互动率，不参与排序（也不影响合并结果）。
   */
  function groupInter(list, mode) {
    const items = list
      .filter((r) => num(r.views) > 0)
      .map((r) => ({ v: num(r.views), i: interactionsOf(r) }))
      .sort((a, b) => a.i / a.v - b.i / b.v);
    const n = items.length;
    if (!n) return { value: null, n: 0, used: 0, trimmed: false, fallback: false };
    let use = items, trimmed = false, fallback = false;
    if (mode === 'trim') {
      if (n >= TRIM_MIN_N) { use = items.slice(1, -1); trimmed = true; } else fallback = true;
    }
    const tv = use.reduce((s, x) => s + x.v, 0);
    const ti = use.reduce((s, x) => s + x.i, 0);
    return { value: tv > 0 ? ti / tv : null, n, used: use.length, trimmed, fallback };
  }

  /**
   * 挂车（isEC）vs 非挂车。
   * mode: 'mean' 条均（默认） | 'trim' 各组各指标剔除最高、最低后再取条均
   * 返回 { mode, ec:{n}, non:{n}, fallback:{ec,non}, metrics:[{key, kind, ec, non, abs, pct}] }
   *   abs / pct 都是「挂车 − 非挂车」，pct 以非挂车为基数。
   */
  function cartCompare(rows, mode) {
    const md = CART_MODES.includes(mode) ? mode : 'mean';
    const list = measured(rows);
    const ecRows = list.filter((r) => r.isEC);
    const nonRows = list.filter((r) => !r.isEC);
    const metrics = CART_METRICS.map((key) => {
      const ec = groupMean(ecRows, key, md);
      const non = groupMean(nonRows, key, md);
      return Object.assign({ key, kind: 'int', ec, non }, delta(ec.value, non.value));
    });
    const ie = groupInter(ecRows, md), inn = groupInter(nonRows, md);
    metrics.push(Object.assign({ key: 'inter', kind: 'pct', ec: ie, non: inn }, delta(ie.value, inn.value)));
    return {
      mode: md,
      ec: { n: ecRows.length },
      non: { n: nonRows.length },
      fallback: {
        ec: md === 'trim' && ecRows.length > 0 && ecRows.length < TRIM_MIN_N,
        non: md === 'trim' && nonRows.length > 0 && nonRows.length < TRIM_MIN_N,
      },
      metrics,
    };
  }

  return {
    num, measured, aggregate, delta, median, spanDays, interactionsOf,
    inCurrent, inCompare,
    PERIOD_METRICS, periodCompare,
    CART_METRICS, CART_MODES, TRIM_MIN_N, groupMean, groupInter, cartCompare,
  };
});

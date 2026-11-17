/**
 * 日期与周期对比工具（前后端共用，唯一一份）
 *
 * - 浏览器里挂在 window.TTPeriod；Node 里 require('./public/shared/period.js')。
 * - 所有日期都是「曼谷墙上日期」的 YYYY-MM-DD 字符串。内部运算只用 Date.UTC 做
 *   「纯日历」加减，绝不经过本机时区 —— 这样在任何时区的机器上结果都一样，
 *   也不会出现 UTC 转换造成的差一天。
 * - 服务端用同一份 compareRange() 推算对比期，前端只负责展示，
 *   两边不可能出现「界面写的是 A 区间、实际抓的是 B 区间」。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TTPeriod = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY = 86400000;
  const TZ_OFFSET_MS = 7 * 3600 * 1000; // Asia/Bangkok，无夏令时
  /** 「全部」模式的起点：早于 TikTok 上线，等价于不设下限 */
  const ALL_FROM = '2016-01-01';

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  /** 解析并校验（2026-02-30 这种不存在的日期返回 null） */
  function parse(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
    return { y, m: mo, d };
  }
  const isValid = (s) => !!parse(s);

  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  /** 自 1970-01-01 起的天数（纯日历） */
  function toDays(s) {
    const p = parse(s);
    if (!p) return NaN;
    return Math.round(Date.UTC(p.y, p.m - 1, p.d) / DAY);
  }
  function fromDays(n) {
    const d = new Date(n * DAY);
    return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const addDays = (s, n) => fromDays(toDays(s) + n);

  /** 含首尾的天数；非法或倒置返回 0 */
  function span(from, to) {
    const a = toDays(from), b = toDays(to);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
    return b - a + 1;
  }

  /** 曼谷的「今天」 */
  function today(now) {
    return new Date((now === undefined ? Date.now() : now) + TZ_OFFSET_MS).toISOString().slice(0, 10);
  }

  /** 周一为一周的开始 */
  function weekStart(s) {
    const dow = new Date(toDays(s) * DAY).getUTCDay(); // 0=周日
    return addDays(s, -((dow + 6) % 7));
  }
  function monthStart(s) {
    const p = parse(s);
    return fmt(p.y, p.m, 1);
  }
  function monthEnd(s) {
    const p = parse(s);
    return fmt(p.y, p.m, daysInMonth(p.y, p.m));
  }
  const isMonthEnd = (s) => s === monthEnd(s);

  /** 月份平移，日号超出目标月天数时夹到月末（3/31 → 2/28 或 2/29） */
  function shiftMonth(s, delta) {
    const p = parse(s);
    const idx = p.y * 12 + (p.m - 1) + delta;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    return fmt(y, m, Math.min(p.d, daysInMonth(y, m)));
  }

  /** 是否恰好是若干个完整自然月（1 号 ~ 某月最后一天） */
  function isFullMonths(from, to) {
    const a = parse(from);
    return !!a && a.d === 1 && isValid(to) && isMonthEnd(to) && from <= to;
  }

  /** 两段闭区间的重叠 */
  function overlap(a1, a2, b1, b2) {
    if (![a1, a2, b1, b2].every(isValid)) return { days: 0, from: null, to: null };
    const s = a1 > b1 ? a1 : b1;
    const e = a2 < b2 ? a2 : b2;
    if (s > e) return { days: 0, from: null, to: null };
    return { days: span(s, e), from: s, to: e };
  }

  /* ---------------- 快捷日期 ---------------- */
  const PRESETS = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'last7', 'last30', 'last90', 'all'];

  function presetRange(key, t) {
    const td = t || today();
    switch (key) {
      case 'today': return { from: td, to: td };
      case 'yesterday': { const y = addDays(td, -1); return { from: y, to: y }; }
      case 'thisWeek': return { from: weekStart(td), to: td };
      case 'lastWeek': { const mon = addDays(weekStart(td), -7); return { from: mon, to: addDays(mon, 6) }; }
      case 'thisMonth': return { from: monthStart(td), to: td };
      case 'lastMonth': { const s = shiftMonth(monthStart(td), -1); return { from: s, to: monthEnd(s) }; }
      case 'last7': return { from: addDays(td, -6), to: td };
      case 'last30': return { from: addDays(td, -29), to: td };
      case 'last90': return { from: addDays(td, -89), to: td };
      case 'all': return { from: ALL_FROM, to: td };
      default: return null;
    }
  }

  /** 当前起止日期对应哪个快捷项；都不匹配就是 custom。同区间多个候选时取列表里靠前的 */
  function matchPreset(from, to, t) {
    for (const k of PRESETS) {
      const r = presetRange(k, t);
      if (r.from === from && r.to === to) return k;
    }
    return 'custom';
  }

  const isAll = (from) => isValid(from) && from <= ALL_FROM;

  /**
   * 把用户改过的起止日期规整成合法区间。
   * changed: 'from' | 'to' —— 用户刚改的是哪一头；起止倒置时让另一头跟过来，而不是悄悄交换。
   * 返回 { from, to, fixes: [...] }，fixes 里是做过的修正（给界面提示用）：
   *   'invalid'（非法日期，回退到 fallback）/ 'future'（晚于今天）/ 'tooEarly' / 'swapped'
   */
  function normalizeRange(from, to, opts) {
    const o = opts || {};
    const max = o.max || today();
    const min = o.min || ALL_FROM;
    const fixes = [];
    let f = from, t = to;
    if (!isValid(f)) { f = isValid(o.fallbackFrom) ? o.fallbackFrom : monthStart(max); fixes.push('invalid'); }
    if (!isValid(t)) { t = isValid(o.fallbackTo) ? o.fallbackTo : max; fixes.push('invalid'); }
    if (t > max) { t = max; fixes.push('future'); }
    if (f > max) { f = max; fixes.push('future'); }
    if (f < min) { f = min; fixes.push('tooEarly'); }
    if (t < min) { t = min; fixes.push('tooEarly'); }
    if (f > t) {
      if (o.changed === 'to') f = t; else t = f;
      fixes.push('swapped');
    }
    return { from: f, to: t, fixes: [...new Set(fixes)] };
  }

  /* ---------------- 周期对比 ---------------- */
  const COMPARE_MODES = ['none', 'previous', 'lastWeek', 'lastMonth', 'custom'];

  /**
   * 推算对比期。
   *   previous  上一周期：与本期同天数、紧邻本期之前
   *   lastWeek  上周同期：整段向前平移 7 天
   *   lastMonth 上月同期：起止各取上个月的同一日（没有那一天就取月末）；
   *             本期恰好是完整自然月 → 对比上一个完整自然月
   *   custom    自定义：用 custom.from / custom.to
   *
   * 返回 null 表示不对比（mode=none、「全部」模式、或入参非法）；否则：
   *   { mode, from, to, days, currentDays, overlapDays, overlapFrom, overlapTo,
   *     shiftedWeek   —— lastWeek 且本期超过 7 天：只是「平移一周」，不是完整自然周环比
   *     fullMonth     —— lastMonth 且按完整自然月对齐
   *     clamped       —— lastMonth 且有日期被夹到了月末（如 3/31 → 2/28）
   *     sameSpan      —— 两期天数是否相同（不同则总量不能直接比，要看日均）}
   */
  function compareRange(mode, from, to, custom) {
    if (!mode || mode === 'none') return null;
    if (!isValid(from) || !isValid(to) || from > to) return null;
    if (isAll(from)) return null; // 「全部」没有可比的上一期
    const n = span(from, to);
    let cf, ct;
    const flags = { shiftedWeek: false, fullMonth: false, clamped: false };

    if (mode === 'previous') {
      ct = addDays(from, -1);
      cf = addDays(ct, -(n - 1));
    } else if (mode === 'lastWeek') {
      cf = addDays(from, -7);
      ct = addDays(to, -7);
      flags.shiftedWeek = n > 7;
    } else if (mode === 'lastMonth') {
      cf = shiftMonth(from, -1);
      if (isFullMonths(from, to)) {
        ct = monthEnd(shiftMonth(monthStart(to), -1));
        flags.fullMonth = true;
      } else {
        ct = shiftMonth(to, -1);
        flags.clamped = parse(cf).d !== parse(from).d || parse(ct).d !== parse(to).d;
      }
    } else if (mode === 'custom') {
      if (!custom || !isValid(custom.from) || !isValid(custom.to) || custom.from > custom.to) return null;
      cf = custom.from;
      ct = custom.to;
    } else {
      return null;
    }
    if (cf < ALL_FROM) cf = ALL_FROM;
    if (ct < cf) return null;

    const ov = overlap(from, to, cf, ct);
    const days = span(cf, ct);
    return Object.assign(
      { mode, from: cf, to: ct, days, currentDays: n, sameSpan: days === n, overlapDays: ov.days, overlapFrom: ov.from, overlapTo: ov.to },
      flags
    );
  }

  /** 一条视频的发布日期落在哪一期（两期重叠时可以同时属于两期） */
  function classify(date, ranges) {
    const r = ranges || {};
    const hasCmp = !!(r.compareFrom && r.compareTo);
    const hasCur = !!(r.currentFrom && r.currentTo);
    const inCurrent = hasCur ? date >= r.currentFrom && date <= r.currentTo : !hasCmp || !(date >= r.compareFrom && date <= r.compareTo);
    const inCompare = hasCmp && date >= r.compareFrom && date <= r.compareTo;
    return { inCurrent, inCompare, period: inCurrent ? 'current' : inCompare ? 'compare' : 'other' };
  }

  return {
    ALL_FROM, PRESETS, COMPARE_MODES, TZ_OFFSET_MS,
    parse, isValid, daysInMonth, toDays, fromDays, addDays, span, today,
    weekStart, monthStart, monthEnd, isMonthEnd, shiftMonth, isFullMonths, overlap,
    presetRange, matchPreset, isAll, normalizeRange, compareRange, classify,
  };
});

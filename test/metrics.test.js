const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../public/shared/metrics.js');

const v = (views, likes = 0, isEC = false, extra = {}) => ({ views, likes, comments: 0, shares: 0, saves: 0, reposts: 0, isEC, ...extra });

test('互动率按合并口径（互动总量 ÷ 播放总量）', () => {
  const a = M.aggregate([v(100, 50), v(10000, 100)]);
  assert.equal(a.inter, 150 / 10100); // 不是 (0.5 + 0.01) / 2
  assert.equal(a.avgViews, 5050);
  assert.equal(a.medViews, 5050);
});

test('没有数据 = null，真实 0 = 0；变化率不出 Infinity / NaN', () => {
  const a = M.aggregate([]);
  assert.equal(a.n, 0);
  assert.equal(a.views, 0);
  assert.equal(a.avgViews, null);
  assert.equal(a.inter, null);
  assert.deepEqual(M.delta(10, 0), { abs: 10, pct: null });
  assert.deepEqual(M.delta(10, null), { abs: null, pct: null });
  assert.deepEqual(M.delta(0, 0), { abs: 0, pct: null });
  assert.deepEqual(M.delta(15, 10), { abs: 5, pct: 0.5 });
  // 搜索框解析进来的行没有播放量，不参与计算
  assert.equal(M.aggregate([v(null), v(100)]).n, 1);
});

test('周期对比：总量 + 日均；两期天数不同', () => {
  const rows = [
    { ...v(100, 10), date: '2026-11-10', inCurrent: true, inCompare: false },
    { ...v(300, 30), date: '2026-11-11', inCurrent: true, inCompare: false },
    { ...v(200, 0), date: '2026-10-20', inCurrent: false, inCompare: true },
  ];
  const pc = M.periodCompare(rows, { currentFrom: '2026-11-10', currentTo: '2026-11-11', compareFrom: '2026-10-17', compareTo: '2026-10-20' });
  assert.equal(pc.currentDays, 2);
  assert.equal(pc.compareDays, 4);
  assert.equal(pc.sameSpan, false);
  const m = Object.fromEntries(pc.metrics.map((x) => [x.key, x]));
  assert.equal(m.views.cur, 400);
  assert.equal(m.views.cmp, 200);
  assert.equal(m.views.pct, 1);
  assert.equal(m.viewsPerDay.cur, 200);
  assert.equal(m.viewsPerDay.cmp, 50);
  assert.equal(m.viewsPerDay.pct, 3);
  assert.equal(m.inter.cmp, 0); // 有播放、零互动 → 真实的 0
  assert.equal(m.inter.pct, null); // 基数 0 → 不算变化率
});

test('对比期没有视频：数量是 0，条均是「无数据」', () => {
  const rows = [{ ...v(100), date: '2026-11-10', inCurrent: true, inCompare: false }];
  const pc = M.periodCompare(rows, { currentFrom: '2026-11-10', currentTo: '2026-11-10', compareFrom: '2026-11-09', compareTo: '2026-11-09' });
  const m = Object.fromEntries(pc.metrics.map((x) => [x.key, x]));
  assert.equal(pc.compareEmpty, true);
  assert.equal(m.videos.cmp, 0);
  assert.equal(m.videos.pct, null);
  assert.equal(m.avgViews.cmp, null);
  assert.equal(m.avgViews.abs, null);
});

test('挂车对比：条均', () => {
  const rows = [v(100, 10, true), v(300, 30, true), v(1000, 0), v(3000, 0)];
  const c = M.cartCompare(rows, 'mean');
  const m = Object.fromEntries(c.metrics.map((x) => [x.key, x]));
  assert.equal(c.ec.n, 2);
  assert.equal(c.non.n, 2);
  assert.equal(m.views.ec.value, 200);
  assert.equal(m.views.non.value, 2000);
  assert.equal(m.views.abs, -1800);
  assert.equal(m.views.pct, -0.9);
  assert.equal(m.inter.ec.value, 0.1);
  assert.equal(m.inter.non.value, 0);
});

test('挂车对比：每个指标各自剔除最高、最低', () => {
  // 播放最高的视频点赞最低 —— 两个指标剔除的是不同的视频
  const ec = [v(1, 50, true), v(10, 20, true), v(20, 30, true), v(1000, 1, true)];
  const c = M.cartCompare(ec, 'trim');
  const m = Object.fromEntries(c.metrics.map((x) => [x.key, x]));
  assert.equal(m.views.ec.value, 15); // 去掉 1 和 1000
  assert.equal(m.views.ec.used, 2);
  assert.equal(m.views.ec.trimmed, true);
  assert.equal(m.likes.ec.value, 25); // 去掉 1 和 50
  assert.equal(c.non.n, 0);
  assert.equal(m.views.non.value, null);
  assert.equal(m.views.pct, null);
});

test('挂车对比：样本不足 3 条自动回退为普通条均', () => {
  const rows = [v(100, 0, true), v(300, 0, true), v(10), v(20), v(30)];
  const c = M.cartCompare(rows, 'trim');
  const m = Object.fromEntries(c.metrics.map((x) => [x.key, x]));
  assert.equal(c.fallback.ec, true);
  assert.equal(c.fallback.non, false);
  assert.equal(m.views.ec.value, 200);
  assert.equal(m.views.ec.fallback, true);
  assert.equal(m.views.non.value, 20);
});

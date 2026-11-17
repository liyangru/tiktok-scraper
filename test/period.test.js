const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/shared/period.js');

const cr = (mode, f, t, c) => {
  const r = P.compareRange(mode, f, t, c);
  return r && [r.from, r.to];
};

test('日期校验：闰年 / 月末 / 非法日期', () => {
  assert.equal(P.isValid('2024-02-29'), true);
  assert.equal(P.isValid('2025-02-29'), false);
  assert.equal(P.isValid('2026-04-31'), false);
  assert.equal(P.isValid('2026-13-01'), false);
  assert.equal(P.daysInMonth(2024, 2), 29);
  assert.equal(P.daysInMonth(2100, 2), 28);
  assert.equal(P.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(P.addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(P.span('2026-11-10', '2026-11-16'), 7);
  assert.equal(P.span('2026-11-16', '2026-11-10'), 0);
});

test('曼谷「今天」不受本机时区影响', () => {
  // 2026-11-16 18:30 UTC = 曼谷 11-17 01:30
  assert.equal(P.today(Date.UTC(2026, 10, 16, 18, 30)), '2026-11-17');
  assert.equal(P.today(Date.UTC(2026, 10, 16, 16, 59)), '2026-11-16');
});

test('快捷日期', () => {
  const td = '2026-11-17'; // 周二
  assert.deepEqual(P.presetRange('today', td), { from: td, to: td });
  assert.deepEqual(P.presetRange('yesterday', td), { from: '2026-11-16', to: '2026-11-16' });
  assert.deepEqual(P.presetRange('thisWeek', td), { from: '2026-11-16', to: td });
  assert.deepEqual(P.presetRange('lastWeek', td), { from: '2026-11-09', to: '2026-11-15' });
  assert.deepEqual(P.presetRange('thisMonth', td), { from: '2026-11-01', to: td });
  assert.deepEqual(P.presetRange('lastMonth', td), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(P.presetRange('last7', td), { from: '2026-11-11', to: td });
  assert.deepEqual(P.presetRange('last30', td), { from: '2026-10-19', to: td });
  assert.deepEqual(P.presetRange('lastMonth', '2026-01-05'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(P.presetRange('thisWeek', '2026-11-16'), { from: '2026-11-16', to: '2026-11-16' }); // 周一
  assert.deepEqual(P.presetRange('lastWeek', '2026-11-22'), { from: '2026-11-09', to: '2026-11-15' }); // 周日
  assert.equal(P.matchPreset('2026-10-01', '2026-10-31', td), 'lastMonth');
  assert.equal(P.matchPreset('2026-10-02', '2026-10-31', td), 'custom');
});

test('上一周期：同天数、紧邻之前', () => {
  assert.deepEqual(cr('previous', '2026-11-10', '2026-11-16'), ['2026-11-03', '2026-11-09']);
  assert.deepEqual(cr('previous', '2026-03-01', '2026-03-01'), ['2026-02-28', '2026-02-28']);
  assert.deepEqual(cr('previous', '2027-01-01', '2027-01-10'), ['2026-12-22', '2026-12-31']);
});

test('上周同期：平移 7 天；超过 7 天要标记、且会重叠', () => {
  const r = P.compareRange('lastWeek', '2026-11-10', '2026-11-16');
  assert.deepEqual([r.from, r.to], ['2026-11-03', '2026-11-09']);
  assert.equal(r.shiftedWeek, false);
  assert.equal(r.overlapDays, 0);
  const r2 = P.compareRange('lastWeek', '2026-11-01', '2026-11-14');
  assert.deepEqual([r2.from, r2.to], ['2026-10-25', '2026-11-07']);
  assert.equal(r2.shiftedWeek, true);
  assert.equal(r2.overlapDays, 7);
});

test('上月同期：月末夹取 / 闰年 / 完整自然月 / 跨年', () => {
  assert.deepEqual(cr('lastMonth', '2026-11-01', '2026-11-17'), ['2026-10-01', '2026-10-17']);
  assert.deepEqual(cr('lastMonth', '2026-03-31', '2026-03-31'), ['2026-02-28', '2026-02-28']);
  assert.deepEqual(cr('lastMonth', '2024-03-31', '2024-03-31'), ['2024-02-29', '2024-02-29']);
  const c = P.compareRange('lastMonth', '2026-03-15', '2026-03-31');
  assert.deepEqual([c.from, c.to], ['2026-02-15', '2026-02-28']);
  assert.equal(c.clamped, true);
  // 完整自然月 → 上一个完整自然月（不是 2/1~2/28 之外的日子）
  const f = P.compareRange('lastMonth', '2026-03-01', '2026-03-31');
  assert.deepEqual([f.from, f.to], ['2026-02-01', '2026-02-28']);
  assert.equal(f.fullMonth, true);
  assert.deepEqual(cr('lastMonth', '2026-02-01', '2026-02-28'), ['2026-01-01', '2026-01-31']);
  assert.deepEqual(cr('lastMonth', '2026-01-01', '2026-01-31'), ['2025-12-01', '2025-12-31']);
  assert.deepEqual(cr('lastMonth', '2026-01-10', '2026-01-20'), ['2025-12-10', '2025-12-20']);
  // 多个完整月
  assert.deepEqual(cr('lastMonth', '2026-04-01', '2026-05-31'), ['2026-03-01', '2026-04-30']);
});

test('不对比 / 全部 / 自定义 / 非法', () => {
  assert.equal(P.compareRange('none', '2026-11-01', '2026-11-17'), null);
  assert.equal(P.compareRange('previous', P.ALL_FROM, '2026-11-17'), null);
  assert.deepEqual(cr('custom', '2026-11-01', '2026-11-17', { from: '2026-09-01', to: '2026-09-30' }), ['2026-09-01', '2026-09-30']);
  assert.equal(P.compareRange('custom', '2026-11-01', '2026-11-17', { from: '2026-09-30', to: '2026-09-01' }), null);
  assert.equal(P.compareRange('previous', '2026-11-17', '2026-11-01'), null);
  assert.equal(P.compareRange('previous', '2026-02-30', '2026-03-01'), null);
});

test('起止日期规整', () => {
  const td = '2026-11-17';
  assert.deepEqual(P.normalizeRange('2026-11-20', '2026-11-10', { max: td, changed: 'from' }), {
    from: '2026-11-17', to: '2026-11-17', fixes: ['future', 'swapped'],
  });
  assert.deepEqual(P.normalizeRange('2026-11-12', '2026-11-10', { max: td, changed: 'to' }).from, '2026-11-10');
  assert.deepEqual(P.normalizeRange('2026-11-12', '2026-11-10', { max: td, changed: 'from' }).to, '2026-11-12');
  assert.deepEqual(P.normalizeRange('bad', '2026-11-10', { max: td }).fixes, ['invalid']);
});

test('期次归属允许重叠', () => {
  const rg = { currentFrom: '2026-11-01', currentTo: '2026-11-14', compareFrom: '2026-10-25', compareTo: '2026-11-07' };
  assert.deepEqual(P.classify('2026-11-03', rg), { inCurrent: true, inCompare: true, period: 'current' });
  assert.deepEqual(P.classify('2026-10-26', rg), { inCurrent: false, inCompare: true, period: 'compare' });
  assert.deepEqual(P.classify('2026-11-10', rg), { inCurrent: true, inCompare: false, period: 'current' });
  assert.equal(P.classify('2026-11-10', { currentFrom: '2026-11-01', currentTo: '2026-11-14' }).inCurrent, true);
});

/* 插件（浏览器采集模式）端到端：prepare_scrape → submit_account ×2 → 自动出摘要 → 明细 → 导出 xlsx / csv */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const zlib = require('zlib');

const FX = require('./fixtures/browser-collect.json');

function server(root, env) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-plugin-'));
  const p = spawn(process.execPath, [path.join(root, 'mcp', 'browser-server.js')], { env: { ...process.env, TT_BASE_DIR: base, ...env } });
  let buf = '';
  let n = 0;
  const pend = {};
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (pend[m.id]) pend[m.id](m);
    }
  });
  const rpc = (method, params) =>
    new Promise((r) => {
      const id = ++n;
      pend[id] = r;
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const txt = r.result.content[0].text;
    if (r.result.isError) throw new Error(txt);
    return JSON.parse(txt);
  };
  return { p, rpc, call, base };
}

/** 读 xlsx（zip）里的文件列表与某个文件内容，验证结构 */
function unzip(buf) {
  // 按中央目录读（兼容带数据描述符的 zip，例如 exceljs 生成的）
  let e = buf.length - 22;
  while (buf.readUInt32LE(e) !== 0x06054b50) e--;
  let p = buf.readUInt32LE(e + 16);
  const n = buf.readUInt16LE(e + 10);
  const out = {};
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10);
    const comp = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28);
    const xl = buf.readUInt16LE(p + 30);
    const cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString();
    const lnl = buf.readUInt16LE(off + 26);
    const lxl = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnl + lxl, off + 30 + lnl + lxl + comp);
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString();
    p += 46 + nl + xl + cl;
  }
  return out;
}

// 仓库里装了 exceljs → 完整报表；插件目录强制走零依赖的精简报表
for (const [root, lite] of [[path.join(__dirname, '..'), false], [path.join(__dirname, '..', 'plugin'), true]]) {
  test(`插件流程（${lite ? '独立插件 · 精简 Excel' : '仓库 · 完整 Excel'}）`, async () => {
    const { p, rpc, call, base } = server(root, lite ? { TT_XLSX_LITE: '1' } : {});
    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
      assert.strictEqual(init.result.serverInfo.name, 'tiktok-scraper');
      const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
      assert.deepStrictEqual(tools.sort(), ['export_report', 'get_report', 'list_scrapes', 'list_videos', 'prepare_scrape', 'submit_account']);

      const plan = await call('prepare_scrape', { handles: FX.accounts.map((a) => '@' + a.handle), from: FX.currentFrom, to: FX.currentTo, compare: 'lastMonth' });
      assert.deepStrictEqual(plan.collect, { from: FX.from, to: FX.to });
      assert.ok(plan.script.includes('W.TTC = async function'));
      assert.ok(!plan.script.includes('/*'), '脚本已去注释');
      new Function(plan.script); // 语法正确

      const [a, b] = FX.accounts;
      const r1 = await call('submit_account', { job_id: plan.job_id, handle: a.handle, fields: undefined, items: a.items, profile: a.profile, complete: a.complete, oldestDate: a.oldestDate });
      assert.deepStrictEqual(r1.remaining, ['@' + b.handle]);
      const pending = await call('get_report', { job_id: plan.job_id });
      assert.strictEqual(pending.status, 'collecting');

      const sum = await call('submit_account', { job_id: plan.job_id, handle: b.handle, items: b.items, profile: b.profile, complete: b.complete, oldestDate: b.oldestDate });
      assert.strictEqual(sum.status, 'done');
      assert.ok(sum.totals.videos > 0);
      assert.strictEqual(sum.accounts.length, 2);
      assert.strictEqual(sum.compare.mode, 'lastMonth');
      assert.ok(sum.cart && sum.cart.cartVideos > 0);

      const trim = await call('get_report', { job_id: plan.job_id, cart_mode: 'trim' });
      assert.strictEqual(trim.cart.mode, 'trim');

      const v = await call('list_videos', { job_id: plan.job_id, cart_only: true, limit: 3 });
      assert.ok(v.videos.length > 0 && v.videos.every((x) => x.cart));

      const xf = path.join(base, 'r.xlsx');
      assert.strictEqual((await call('export_report', { job_id: plan.job_id, path: xf })).file, xf);
      const z = unzip(fs.readFileSync(xf));
      assert.ok(z['xl/workbook.xml'].includes('<sheet '));
      if (lite) assert.ok(z['xl/workbook.xml'].includes('视频明细') && z['xl/worksheets/sheet3.xml'].includes('tiktok.com'));
      const cf = path.join(base, 'r.csv');
      await call('export_report', { job_id: plan.job_id, format: 'csv', path: cf });
      assert.ok(fs.readFileSync(cf, 'utf8').split('\n').length > 10);

      const ls = await call('list_scrapes', {});
      assert.strictEqual(ls[0].status, 'done');

      // 参数错误
      await assert.rejects(call('submit_account', { job_id: plan.job_id, handle: 'nobody' }), /没有这个账号/);
      await assert.rejects(call('prepare_scrape', { handles: ['ok_name'], preset: 'thisMonth', compare: 'lastWeek' }), /7 天/);
    } finally {
      p.stdin.end();
    }
  });
}

test('精简 xlsx 能被解析（共享字符串 / 样式 / 超链接）', () => {
  const { buildXlsx } = require('../lib/xlsx-lite');
  const buf = buildXlsx([{ name: 'A/B:测试', columns: [{ header: '名称', width: 10 }, { header: '数', fmt: 'int' }], rows: [['x<&>', 1234], [{ v: 'link', link: 'https://a.b/?q=1&r=2' }, { v: 0.5, fmt: 'pct' }]] }]);
  const z = unzip(buf);
  assert.ok(z['xl/worksheets/sheet1.xml'].includes('x&lt;&amp;&gt;'));
  assert.ok(z['xl/worksheets/_rels/sheet1.xml.rels'].includes('q=1&amp;r=2'));
  assert.ok(z['xl/workbook.xml'].includes('A B 测试'));
});

test('plugin/ 与源文件一致（改了源文件要运行 npm run build:plugin）', () => {
  const { check } = require('../scripts/build-plugin.js');
  assert.deepStrictEqual(check(), []);
});

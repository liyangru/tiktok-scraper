const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function startServer() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-mcp-'));
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'server.js')], {
    env: { ...process.env, TT_BASE_DIR: base, TT_NO_AUTO_INSTALL: '1', CHROME_PATH: process.execPath },
  });
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
  const call = (method, params) =>
    new Promise((r) => {
      const id = ++n;
      pend[id] = r;
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { p, call, base };
}

test('MCP：握手、工具列表、参数校验', async () => {
  const { p, call } = startServer();
  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.strictEqual(init.result.serverInfo.name, 'tiktok-scraper');
    assert.strictEqual(init.result.protocolVersion, '2025-06-18');

    const tl = await call('tools/list', {});
    const names = tl.result.tools.map((t) => t.name);
    for (const n of ['start_scrape', 'get_scrape', 'list_videos', 'list_scrapes', 'export_report', 'stop_scrape', 'doctor']) assert.ok(names.includes(n), n);
    for (const t of tl.result.tools) assert.strictEqual(t.inputSchema.type, 'object');

    const ls = await call('tools/call', { name: 'list_scrapes', arguments: {} });
    assert.deepStrictEqual(JSON.parse(ls.result.content[0].text), []);

    const bad = await call('tools/call', { name: 'start_scrape', arguments: { handles: ['bad handle!'] } });
    assert.strictEqual(bad.result.isError, true);

    const none = await call('tools/call', { name: 'get_scrape', arguments: {} });
    assert.strictEqual(none.result.isError, true);

    const unk = await call('nope/method', {});
    assert.strictEqual(unk.error.code, -32601);
  } finally {
    p.stdin.end();
  }
});

test('plugin/ 与源文件一致（改了源文件要运行 npm run build:plugin）', () => {
  const { check } = require('../scripts/build-plugin.js');
  assert.deepStrictEqual(check(), []);
});

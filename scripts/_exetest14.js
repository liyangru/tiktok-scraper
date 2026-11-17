/**
 * 1.1.9 验收：真跑打包 exe，并核对本轮修的四件事
 *  ① 创作中心登录态能读出来（账号列表 + /state 回落磁盘）② 卖家中心站点解析
 *  ③ 创作中心 insight 端点 ④ 模块版本是否是新版
 * ⚠️ 必须清掉沙箱注入的 ELECTRON_RUN_AS_NODE / NODE_OPTIONS。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = process.argv[2] || path.join(ROOT, 'release', 'win-unpacked', 'TikTokScraper.exe');
const SHOT = path.join(ROOT, '_appshot.png');
const out = [];
const log = (s) => { out.push(s); console.log(s); };
const W = () => fs.writeFileSync(path.join(ROOT, '_exetest.txt'), out.join('\n'), 'utf8');

function getOnce(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 20000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
/** 刚起来时连接可能被重置（端口还在接管中），重试几次 */
async function get(port, p, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await getOnce(port, p); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1200)); }
  }
  throw last;
}
const j = (s) => { try { return JSON.parse(s); } catch (_) { return {}; } };

(async () => {
  const userData = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'tiktok-scraper'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'TikTokScraper'),
  ].find((p) => fs.existsSync(p)) || path.join(os.homedir(), 'AppData', 'Roaming', 'tiktok-scraper');
  const runtimeFile = path.join(userData, 'runtime.json');
  try { fs.rmSync(runtimeFile, { force: true }); } catch (_) {}
  try { fs.rmSync(SHOT, { force: true }); } catch (_) {}

  const env = { ...process.env, TT_SHOT: SHOT, ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  log('启动: ' + EXE);
  try { execSync('taskkill /F /IM TikTokScraper.exe 2>nul'); } catch (_) {}
  await new Promise((r) => setTimeout(r, 800));
  const child = spawn(EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let so = '', se = '', exited = null;
  child.stdout.on('data', (c) => (so += c));
  child.stderr.on('data', (c) => (se += c));
  child.on('exit', (code) => { exited = code; log('!! exe 退出 code=' + code); });
  child.on('error', (e) => log('!! spawn 失败 ' + e.message));

  const t0 = Date.now();
  let runtime = null;
  while (Date.now() - t0 < 120000) {
    if (exited !== null) break;
    if (fs.existsSync(runtimeFile)) {
      try { runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); break; } catch (_) {}
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!runtime) {
    log('!! runtime.json 未出现');
    log('--- stdout ---\n' + so.slice(0, 1500));
    log('--- stderr ---\n' + se.slice(0, 2500));
    try { execSync('taskkill /F /IM TikTokScraper.exe 2>nul'); } catch (_) {}
    W(); process.exit(1);
  }
  const P = runtime.port;
  log(`✅ runtime.json  port=${P}  pid=${runtime.pid}  启动=${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const h = j((await get(P, '/api/health')).body);
  log(`health ok=${h.ok} version=${h.version} chromeFound=${h.chromeFound}`);

  const mj = j((await get(P, '/api/modules')).body);
  log('modules：' + (mj.modules || []).map((m) => `${m.id}@${m.version}${m.installed ? '' : '(未装)'}`).join('  '));

  log('\n--- ① 创作中心登录态（原来的 bug：登录了却读不出来）---');
  const ta = j((await get(P, '/api/tiktok-login/accounts')).body);
  log('accounts: ' + JSON.stringify(ta.accounts || []));
  const ts = j((await get(P, '/api/tiktok-login/state')).body);
  log('state: ' + JSON.stringify(ts));

  log('\n--- ② 卖家中心站点解析（原来的 bug：域名写死跨境）---');
  const sa = j((await get(P, '/api/seller-import/accounts')).body);
  log('accounts: ' + JSON.stringify(sa.accounts || []));
  const sid = (sa.accounts || [])[0] && sa.accounts[0].id;
  if (sid) log('target: ' + (await get(P, `/api/seller-import/accounts/${encodeURIComponent(sid)}/target`)).body);

  log('\n--- ③ 创作中心账号趋势数据（原来的 bug：抓不到 / 只有一个来源）---');
  const ins = j((await get(P, '/api/tiktok-login/insight')).body);
  log('ok=' + ins.ok + ' handle=' + (ins.handle || '') + ' 序列=' + JSON.stringify(
    Object.fromEntries(Object.entries(ins.series || {}).map(([k, v]) => [k, v.length]))
  ));
  if (ins.meta && ins.meta.traffic) log('流量来源: ' + JSON.stringify(ins.meta.traffic));

  log('\n--- ④ 未知 API 必须返回 JSON 404（不能是 HTML）---');
  const nf = await get(P, '/api/__nope__');
  log(`status=${nf.status} body=${nf.body.slice(0, 120)}`);

  const t1 = Date.now();
  while (Date.now() - t1 < 45000 && !fs.existsSync(SHOT)) await new Promise((r) => setTimeout(r, 700));
  log(fs.existsSync(SHOT) ? '\n✅ 界面截图: ' + SHOT : '\n⚠️ 45s 内无截图');

  log('\n--- exe stdout ---\n' + so.slice(-2500));
  log('--- exe stderr ---\n' + se.slice(-1500));
  try { execSync('taskkill /F /IM TikTokScraper.exe 2>nul'); } catch (_) {}
  await new Promise((r) => setTimeout(r, 1200));
  W();
})().catch((e) => { log('FATAL ' + e.stack); try { execSync('taskkill /F /IM TikTokScraper.exe 2>nul'); } catch (_) {} W(); process.exit(1); });

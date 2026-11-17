/**
 * 验收测试：真实运行打包出的 TikTokScraper-1.0.1.exe
 * ⚠️ 必须清掉沙箱注入的 ELECTRON_RUN_AS_NODE / NODE_OPTIONS ——
 *    否则 Electron 会被当成纯 Node 跑，参数解析直接报错退出。
 *    （这只是本机调试环境污染；别人的机器上没有这两个变量。）
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

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 8000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

(async () => {
  // ⚠️ userData 名字跟 package.json 的 name 走（不是 productName）：Roaming/tiktok-scraper
  const userData = [path.join(os.homedir(), 'AppData', 'Roaming', 'tiktok-scraper'), path.join(os.homedir(), 'AppData', 'Roaming', 'TikTokScraper')]
    .find((p) => fs.existsSync(p)) || path.join(os.homedir(), 'AppData', 'Roaming', 'tiktok-scraper');
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
    log('\n--- stdout ---\n' + so.slice(0, 2000));
    log('\n--- stderr ---\n' + se.slice(0, 3000));
    try { child.kill(); } catch (_) {}
    try { execSync('taskkill /F /IM TikTokScraper.exe 2>nul'); } catch (_) {}
    W(); process.exit(1);
  }
  log(`✅ runtime.json  port=${runtime.port}  pid=${runtime.pid}  启动=${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const h = await get(runtime.port, '/api/health');
  log('health ' + h.status + '  ' + h.body.slice(0, 220));

  const mods = await get(runtime.port, '/api/modules');
  let mj = {};
  try { mj = JSON.parse(mods.body); } catch (_) {}
  log('modules 个数=' + (mj.modules || []).length + '  indexError=' + (mj.indexError || '无'));
  for (const m of (mj.modules || [])) log(`  - ${m.id} v${m.version} installed=${!!m.installed} name=${m.name}`);

  const st = await get(runtime.port, '/api/settings/storage');
  log('storage ' + st.status + '  ' + st.body.slice(0, 300));

  // 自带 Chromium 解压到哪了
  const browsersDir = path.join(userData, 'browsers');
  log('browsers 解压: ' + fs.existsSync(browsersDir));
  if (fs.existsSync(browsersDir)) log('  ' + fs.readdirSync(browsersDir).join(', '));

  const t1 = Date.now();
  while (Date.now() - t1 < 40000 && !fs.existsSync(SHOT)) await new Promise((r) => setTimeout(r, 700));
  log(fs.existsSync(SHOT) ? '✅ 界面截图: ' + SHOT : '⚠️ 40s 内无截图');

  try { child.kill(); } catch (_) {}
  try { execSync('taskkill /F /IM TikTokScraper.exe 2>nul'); } catch (_) {}
  await new Promise((r) => setTimeout(r, 1200));
  W();
})().catch((e) => { log('FATAL ' + e.stack); try { execSync('taskkill /F /IM TikTokScraper.exe 2>nul'); } catch (_) {} W(); process.exit(1); });

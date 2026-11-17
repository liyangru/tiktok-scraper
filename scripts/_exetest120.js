/**
 * 1.2.0 验收（打包产物）：
 *  ① 应用起来了、版本对  ② 新模块 seller-api 自动安装并启用（内置源自动装）
 *  ③ 签名自检通过  ④ 开放平台状态/授权地址正确  ⑤ 更新检查能连上 GitHub
 *  ⑥ 界面：设置页有「应用更新」分组；工具组里能打开开放平台面板
 * ⚠️ 必须清 ELECTRON_RUN_AS_NODE / NODE_OPTIONS；TEMP 指到 E 盘。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { chromium } = require('../node_modules/playwright');

const ROOT = path.join(__dirname, '..');
const EXE = process.argv[2] || path.join(ROOT, 'release', 'TikTokScraper-1.2.0-portable.exe');
const out = [];
const log = (s) => { out.push(s); console.log(s); };
const W = () => fs.writeFileSync(path.join(ROOT, '_exetest.txt'), out.join('\n'), 'utf8');

function get1(port, p) {
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
async function get(port, p, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await get1(port, p); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1200)); }
  }
  throw last;
}
function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
const J = (s) => { try { return JSON.parse(s); } catch (_) { return {}; } };
const killAll = () => { try { execSync('taskkill /F /IM TikTokScraper.exe 2>nul'); } catch (_) {} };

(async () => {
  const userData = path.join(os.homedir(), 'AppData', 'Roaming', 'tiktok-scraper');
  const runtimeFile = path.join(userData, 'runtime.json');
  try { fs.rmSync(runtimeFile, { force: true }); } catch (_) {}

  const env = { ...process.env, TEMP: 'E:\\_ebtmp', TMP: 'E:\\_ebtmp' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.ELECTRON_NO_ATTACH_CONSOLE;

  log('启动: ' + EXE);
  killAll();
  await new Promise((r) => setTimeout(r, 1500));
  const child = spawn(EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let so = '', exited = null;
  child.stdout.on('data', (c) => (so += c));
  child.stderr.on('data', (c) => (so += c));
  child.on('exit', (c) => { exited = c; });
  child.on('error', (e) => log('!! spawn 失败 ' + e.message));

  const t0 = Date.now();
  let runtime = null;
  while (Date.now() - t0 < 150000) {
    if (exited !== null) break;
    if (fs.existsSync(runtimeFile)) { try { runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); break; } catch (_) {} }
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!runtime) { log('!! runtime.json 未出现（exited=' + exited + '）'); log(so.slice(-1500)); killAll(); W(); process.exit(1); }
  const P = runtime.port;
  log(`✅ 启动 ${((Date.now() - t0) / 1000).toFixed(1)}s  port=${P}`);

  const h = J((await get(P, '/api/health')).body);
  log(`① health version=${h.version} chromeFound=${h.chromeFound}`);
  const mj = J((await get(P, '/api/modules')).body);
  log('② 模块：' + (mj.modules || []).map((m) => `${m.id}@${m.version}${m.installed ? '' : '(未装)'}${m.enabled ? '' : '(未启用)'}`).join('  '));
  const sa = (mj.modules || []).find((m) => m.id === 'seller-api');
  log('   seller-api 自动安装=' + !!(sa && sa.installed) + ' 自动启用=' + !!(sa && sa.enabled));

  log('③ 签名自检: ' + (await get(P, '/api/seller-api/selftest')).body);
  const st = J((await get(P, '/api/seller-api/status')).body);
  log('④ 状态: configured=' + JSON.stringify(st.configured) + ' serviceId=' + st.serviceId + ' authorizeUrl=' + st.authorizeUrl);
  log('   未配置密钥时取店铺 → ' + (await post(P, '/api/seller-api/shops', {})).body.slice(0, 120));

  const up = J((await get(P, '/api/update/check?force=1')).body);
  log('⑤ 更新检查: current=' + up.current + ' latest=' + up.latest + ' hasUpdate=' + up.hasUpdate + ' error=' + (up.error || '无'));

  /* ---------- 界面 ---------- */
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://127.0.0.1:' + P, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const b = document.querySelector('#tipBubble'); if (b) b.style.display = 'none'; });
  await page.click('#settingsBtn');
  await page.waitForTimeout(900);
  const ui = await page.evaluate(() => ({
    hasUpdateGroup: !!document.querySelector('#upCheck'),
    tools: [...document.querySelectorAll('#toolActions button')].map((b) => b.dataset.id + ':' + b.textContent.trim()),
  }));
  log('⑥ 设置页：应用更新按钮=' + ui.hasUpdateGroup + ' 工具入口=' + JSON.stringify(ui.tools));

  // 打开开放平台面板
  const btn = await page.$('#toolActions button[data-id="seller-api"]');
  if (btn) {
    await btn.click();
    await page.waitForTimeout(2200);
    const panel = await page.evaluate(() => {
      const b = document.querySelector('#loginBody');
      return { title: (document.querySelector('#loginTitle') || {}).textContent, text: b.innerText.replace(/\n/g, ' | ').slice(0, 260) };
    });
    log('   面板标题=' + panel.title);
    log('   面板内容=' + panel.text);
    await page.screenshot({ path: path.join(ROOT, '_ui-seller-api.png') });
  } else {
    log('   ⚠ 工具组里没找到 seller-api 入口');
  }
  log('页面错误: ' + (errs.length ? errs.slice(0, 4) : '无'));
  await browser.close();

  killAll();
  await new Promise((r) => setTimeout(r, 1000));
  log('\n--- exe 日志尾部 ---\n' + so.slice(-1200));
  W();
})().catch((e) => { log('FATAL ' + e.stack); killAll(); W(); process.exit(1); });

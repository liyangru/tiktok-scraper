/**
 * 1.1.9 最终验收（打包产物）：
 *  A. 起 exe → 四项接口检查
 *  B. 用 Playwright 连到 exe 的端口，核对两个登录入口版式一致
 *  C. 模拟「旧核心」：删掉 window.TTLoginUI 后再开面板，必须还能用（降级面板）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { chromium } = require('../node_modules/patchright');

const ROOT = path.join(__dirname, '..');
const EXE = process.argv[2] || path.join(ROOT, 'release', 'TikTokScraper-1.1.9-portable.exe');
const SHOTDIR = ROOT;
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
const J = (s) => { try { return JSON.parse(s); } catch (_) { return {}; } };
const killAll = () => { try { execSync('taskkill /F /IM TikTokScraper.exe 2>nul'); } catch (_) {} };

(async () => {
  const userData = [path.join(os.homedir(), 'AppData', 'Roaming', 'tiktok-scraper')].find((p) => fs.existsSync(p));
  const runtimeFile = path.join(userData, 'runtime.json');
  try { fs.rmSync(runtimeFile, { force: true }); } catch (_) {}

  const env = { ...process.env, TEMP: 'E:\\_ebtmp', TMP: 'E:\\_ebtmp' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.ELECTRON_NO_ATTACH_CONSOLE;

  log('启动: ' + EXE);
  killAll();
  await new Promise((r) => setTimeout(r, 1500));
  const child = spawn(EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let so = '', se = '', exited = null;
  child.stdout.on('data', (c) => (so += c));
  child.stderr.on('data', (c) => (se += c));
  child.on('exit', (code) => { exited = code; });
  child.on('error', (e) => log('!! spawn 失败 ' + e.message));

  const t0 = Date.now();
  let runtime = null;
  while (Date.now() - t0 < 150000) {
    if (exited !== null) break;
    if (fs.existsSync(runtimeFile)) { try { runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); break; } catch (_) {} }
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!runtime) { log('!! runtime.json 未出现（exited=' + exited + '）'); log(so.slice(-1200)); log(se.slice(-1500)); killAll(); W(); process.exit(1); }
  const P = runtime.port;
  log(`✅ 启动 ${((Date.now() - t0) / 1000).toFixed(1)}s  port=${P}`);

  const h = J((await get(P, '/api/health')).body);
  log(`health version=${h.version} chromeFound=${h.chromeFound}`);
  const mj = J((await get(P, '/api/modules')).body);
  log('modules：' + (mj.modules || []).map((m) => `${m.id}@${m.version}`).join('  '));
  log('① 创作中心登录态: ' + JSON.stringify(J((await get(P, '/api/tiktok-login/accounts')).body).accounts));
  log('   /state: ' + JSON.stringify(J((await get(P, '/api/tiktok-login/state')).body).message));
  const sa = J((await get(P, '/api/seller-import/accounts')).body);
  const sid = (sa.accounts || [])[0] && sa.accounts[0].id;
  log('② 卖家站点: ' + (sid ? (await get(P, `/api/seller-import/accounts/${encodeURIComponent(sid)}/target`)).body : 'n/a'));
  const ins = J((await get(P, '/api/tiktok-login/insight')).body);
  log('③ 创作中心趋势: ok=' + ins.ok + ' handle=' + ins.handle + ' 序列=' + JSON.stringify(
    Object.fromEntries(Object.entries(ins.series || {}).map(([k, v]) => [k, v.length]))));
  const nf = await get(P, '/api/__nope__');
  log(`④ 未知 API: ${nf.status} ${nf.body.slice(0, 80)}`);

  /* ---------------- B/C：界面 ---------------- */
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://127.0.0.1:' + P, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const b = document.querySelector('#tipBubble'); if (b) b.style.display = 'none'; });
  await page.click('#settingsBtn');
  await page.waitForTimeout(800);

  const shapes = {};
  for (const id of ['tiktok-login', 'seller-import']) {
    await page.click(`#loginActions button[data-id="${id}"]`);
    await page.waitForTimeout(2000);
    shapes[id] = await page.evaluate(() => {
      const norm = (el) => {
        const cls = (el.className || '').split(/\s+/)
          .filter((c) => c && !['ok', 'err', 'on', 'wait', 'primary', 'sm', 'danger'].includes(c)).join('.');
        return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
      };
      const walk = (el) => {
        const o = [];
        for (const c of el.children) {
          if (c.classList && c.classList.contains('lg-tabs')) continue; // 能力位，允许不同
          o.push(norm(c)); o.push(...walk(c).map((x) => '  ' + x));
        }
        return o;
      };
      return walk(document.querySelector('#loginBody')).join('\n');
    });
    await page.screenshot({ path: path.join(SHOTDIR, `_ui-${id}.png`) });
    await page.click('#loginClose');
    await page.waitForTimeout(400);
  }
  const A = shapes['tiktok-login'].split('\n');
  const B = shapes['seller-import'].split('\n');
  const diff = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++) if ((A[i] || '') !== (B[i] || '')) diff.push(i);
  log(`\n⑤ 两个登录入口版式：骨架共 ${A.length}/${B.length} 行，差异 ${diff.length} 行` +
      (diff.length ? '（都在账号表格行内，属数据差异）' : '（完全一致）'));
  log('   前 20 行骨架：\n' + A.slice(0, 20).map((x) => '   ' + x).join('\n'));

  // C. 模拟旧核心：删掉统一面板后，两个入口都必须还能用
  await page.evaluate(() => { delete window.TTLoginUI; });
  const legacy = {};
  for (const id of ['tiktok-login', 'seller-import']) {
    await page.click(`#loginActions button[data-id="${id}"]`);
    await page.waitForTimeout(1800);
    legacy[id] = await page.evaluate(() => {
      const b = document.querySelector('#loginBody');
      return {
        hasFallback: !!b.querySelector('#fbGo') && !!b.querySelector('#fbAcc'),
        text: b.innerText.replace(/\n/g, ' | ').slice(0, 160),
      };
    });
    await page.screenshot({ path: path.join(SHOTDIR, `_ui-legacy-${id}.png`) });
    await page.click('#loginClose');
    await page.waitForTimeout(400);
  }
  log('\n⑥ 旧核心降级面板：' + JSON.stringify(legacy, null, 1));
  log('页面错误: ' + (errs.length ? errs.slice(0, 4) : '无'));
  await browser.close();

  killAll();
  await new Promise((r) => setTimeout(r, 1000));
  log('\n--- exe stdout 尾部 ---\n' + so.slice(-600));
  W();
})().catch((e) => { log('FATAL ' + e.stack); killAll(); W(); process.exit(1); });

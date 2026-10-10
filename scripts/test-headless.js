/**
 * 实验：无头模式能否通过 TikTok？
 * 在干净 IP 上测试 4 种模式，每种只等首个 item_list 数据（25 秒）。
 */
const path = require('path');
const fs = require('fs');
let pw;
try {
  pw = require('patchright');
  ENGINE = 'patchright';
} catch (e) {
  pw = require('playwright-core');
  ENGINE = 'playwright-core';
}
const ENGINE2 = ENGINE;

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = 'https://www.tiktok.com/@loop.earplugs.offi';
const PERSIST = path.resolve('data/profiles/w0');

const BASE_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
  '--lang=th-TH',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
];

const MODES = [
  { name: '1. 无头 headless:true（全新档案）', headless: true, extra: [], persist: false },
  { name: '2. --headless=new（全新档案）', headless: false, extra: ['--headless=new'], persist: false },
  { name: '3. --headless=new（复用持久档案）', headless: false, extra: ['--headless=new'], persist: true },
  { name: '4. 对照：有头弹窗（全新档案）', headless: false, extra: [], persist: false },
];

function freshDir() {
  const d = path.resolve(`data/_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function tryMode(m) {
  const t0 = Date.now();
  let ctx;
  const tmpDir = m.persist ? PERSIST : freshDir();
  try {
    const opts = {
      headless: m.headless,
      executablePath: CHROME,
      locale: 'th-TH',
      timezoneId: 'Asia/Bangkok',
      viewport: { width: 1366, height: 900 },
      args: [...BASE_ARGS, ...m.extra],
    };
    ctx = await pw.chromium.launchPersistentContext(tmpDir, opts);

    const page = ctx.pages()[0] || (await ctx.newPage());
    let got = 0;
    let hits = 0;
    page.on('response', async (res) => {
      if (!res.url().includes('/api/post/item_list')) return;
      hits++;
      try {
        const j = await res.json();
        if (j && j.itemList) got += j.itemList.length;
      } catch (e) {}
    });

    await page.goto(PROFILE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (got > 0) break;
    }
    const title = await page.title().catch(() => '');
    await ctx.close();
    const ok = got > 0;
    console.log(
      `${ok ? '✅ 可行' : '❌ 失败'}  ${m.name}\n        数据 ${got} 条 | API 响应 ${hits} 次 | 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | ${title.slice(0, 45)}`
    );
    return { name: m.name, ok, got };
  } catch (e) {
    if (ctx) await ctx.close().catch(() => {});
    console.log(`❌ 失败  ${m.name}\n        异常: ${(e.message || e).slice(0, 140)}`);
    return { name: m.name, ok: false, got: 0 };
  }
}

(async () => {
  console.log(`引擎: ${ENGINE2} | 浏览器: ${CHROME}\n`);
  const results = [];
  for (const m of MODES) {
    results.push(await tryMode(m));
    console.log('');
    await new Promise((r) => setTimeout(r, 3000)); // 间隔，降低触发限流的概率
  }
  console.log('=== 汇总 ===');
  results.forEach((r) => console.log(`${r.ok ? '✅' : '❌'} ${r.name} (${r.got} 条)`));
})();

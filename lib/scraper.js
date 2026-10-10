/**
 * TikTok 抓取引擎
 *
 * 原理：用真实浏览器打开主页，拦截 TikTok 自己发出的 /api/post/item_list 响应，
 * 直接取原始 JSON（含播放/点赞/评论/分享/收藏/时长/话题标签）。
 *
 * 引擎优先级：
 *   1) patchright —— Playwright 的反检测补丁版（推荐）。修掉了 CDP 指纹泄漏。
 *   2) playwright-core —— 兜底。
 *
 * ⚠️ 硬约束（都踩过）：
 *   - 引擎必须 Patchright（不是 playwright-core）。playwright-core 无头会被 TikTok 的 CDP
 *     指纹拦下（返回空 body）；换 patchright 后无头/有头都能通。早期"必须有头"是误判——
 *     缺的是引擎不是显示器。本地默认有头只是方便你看见浏览器窗口，设 BROWSER_HEADLESS=1 即无头。
 *   - 必须用**持久化用户目录**（launchPersistentContext）。每次都开全新 profile 等于
 *     每次都是"新访客"，极易被限流；持久化后 cookie（ttwid/msToken）会累积，看起来像回头客。
 *   - 并发 >1 不可靠，默认顺序执行。
 */
const fs = require('fs');
const path = require('path');

// ---------- 引擎选择 ----------
let pw;
let ENGINE;
try {
  pw = require('patchright');
  ENGINE = 'patchright';
} catch (e) {
  pw = require('playwright-core');
  ENGINE = 'playwright-core';
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const PROFILE_ROOT = process.env.PROFILE_DIR || path.join(process.env.TT_BASE_DIR || path.join(__dirname, '..'), 'data', 'profiles');

function resolveChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    // Linux
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) {}
  }
  // 退回 Playwright/Patchright 自带的 Chromium（不依赖系统 Chrome）
  try {
    const p = pw.chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 打开一个带持久化配置的浏览器会话。
 * 每个并发槽位用独立 profile 目录，避免互相干扰。
 * 返回的对象上挂 close()，用来关闭整个浏览器。
 */
async function openSession(slot = 0) {
  const exe = resolveChromePath();
  const userDataDir = path.join(PROFILE_ROOT, `w${slot}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const x = 20 + (slot % 4) * 480;
  const y = 20 + Math.floor(slot / 4) * 60;

  const opts = {
    headless: process.env.BROWSER_HEADLESS === '1',
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    viewport: { width: 1366, height: 900 },
    userAgent: UA,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--lang=th-TH',
      `--window-position=${x},${y}`,
      '--window-size=1000,820',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  };
  if (exe) opts.executablePath = exe;
  if (process.env.CHROME_NO_SANDBOX === '1') opts.args.push('--no-sandbox', '--disable-setuid-sandbox');

  const ctx = await pw.chromium.launchPersistentContext(userDataDir, opts);

  // 只有在没有 patchright 时才自己打补丁（patchright 自带的补丁更完整，叠加反而会露馅）
  if (ENGINE !== 'patchright') {
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  }
  return ctx;
}

function readProfile(page) {
  return page.evaluate(() => {
    try {
      const s = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (!s) return null;
      const j = JSON.parse(s.textContent);
      const ud = j.__DEFAULT_SCOPE__ && j.__DEFAULT_SCOPE__['webapp.user-detail'];
      if (!ud || !ud.userInfo) return null;
      return { user: ud.userInfo.user, stats: ud.userInfo.stats };
    } catch (e) {
      return null;
    }
  });
}

/**
 * 抓取单个账号
 * @param {object} ctx 持久化 BrowserContext
 * @param {string} handle 账号名（不含 @）
 * @param {object} opts { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', maxScrolls, onProgress }
 */
async function scrapeAccount(ctx, handle, opts = {}) {
  const from = opts.from ? new Date(opts.from + 'T00:00:00+07:00') : null;
  const to = opts.to ? new Date(opts.to + 'T23:59:59+07:00') : null;
  const maxScrolls = opts.maxScrolls || 400;
  const onProgress = opts.onProgress || (() => {});
  const stopBefore = from ? Math.floor(from.getTime() / 1000) - 20 * 86400 : -Infinity;

  const page = await ctx.newPage();
  const items = new Map();
  let batchIndex = 0;
  let lastBatchOldest = Infinity;
  let lastCursor = Infinity;
  let hasMore = true;
  let apiCalls = 0;

  page.on('response', async (res) => {
    if (!res.url().includes('/api/post/item_list')) return;
    try {
      const j = await res.json();
      if (j && Array.isArray(j.itemList) && j.itemList.length) {
        apiCalls++;
        batchIndex++;
        for (const it of j.itemList) if (it && it.id) items.set(it.id, it);
        // ⚠️ 第一批可能混入置顶的老视频，其 createTime 不可信，不能作为停止依据
        if (batchIndex > 1) {
          lastBatchOldest = Math.min(...j.itemList.map((x) => x.createTime || Infinity));
        }
        const cur = Number(j.cursor);
        if (Number.isFinite(cur) && cur > 0) lastCursor = cur;
        if (typeof j.hasMore === 'boolean') hasMore = j.hasMore;
        onProgress({ found: items.size, batch: apiCalls });
      }
    } catch (e) {}
  });

  const url = `https://www.tiktok.com/@${handle}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(14000);

  if (process.env.SCRAPER_DEBUG === '1') {
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyLen: document.body ? document.body.innerText.length : 0,
    }));
    onProgress({ debug: `页面: ${JSON.stringify(info)}` });
  }

  const prof = await readProfile(page);
  if (!prof) {
    await page.close();
    throw new Error(`找不到账号 @${handle}（可能不存在、被封禁或改名）`);
  }

  let stable = 0;
  let last = -1;
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, 2200);
      const sc = document.scrollingElement || document.documentElement;
      if (sc.scrollTop + window.innerHeight >= sc.scrollHeight - 50) sc.scrollTop = sc.scrollHeight;
    });
    await sleep(2000);

    if (items.size === last) stable++;
    else {
      stable = 0;
      last = items.size;
    }

    if (!hasMore) break;
    if (lastCursor !== Infinity && lastCursor < stopBefore * 1000) break;
    if (batchIndex > 1 && lastBatchOldest < stopBefore) break;

    // ⚠️ 一次数据都没拿到：被限流/识别了，早点退出交给上层重试，
    //    别死滚到底（旧逻辑在 items.size===0 时会空转到 13 分钟）。
    if (apiCalls === 0 && i >= 22) {
      await page.close();
      throw new Error('TikTok 未返回数据（IP 可能被限流）');
    }
    if (stable >= 15) break;
  }

  await page.close();

  let list = [...items.values()];
  if (from || to) {
    list = list.filter((it) => {
      const t = new Date(it.createTime * 1000);
      if (from && t < from) return false;
      if (to && t > to) return false;
      return true;
    });
  }
  list.sort((a, b) => (b.createTime || 0) - (a.createTime || 0));

  return { handle, nickname: prof.user.nickname, user: prof.user, stats: prof.stats, items: list, apiCalls };
}

/**
 * 批量抓取
 *
 * ⚠️ 并发实现要点：每个并发槽位用**独立的持久化配置目录**。
 *    实测同一浏览器开多个标签页时后台页被节流；即使独立进程 + 窗口错位 + 错峰，
 *    第二个账号仍拿不到数据 → 所以默认 CONCURRENCY=1 顺序执行。
 *
 * @param {string[]} handles
 * @param {object} opts { from, to, concurrency, onEvent, attempts }
 */
async function scrapeMany(handles, opts = {}) {
  const concurrency = Math.max(1, Math.min(opts.concurrency || 1, 3));
  const attempts = Math.max(1, Math.min(opts.attempts || 3, 5));
  const onEvent = opts.onEvent || (() => {});
  const results = [];
  const sessions = [];

  try {
    for (let i = 0; i < Math.min(concurrency, handles.length); i++) sessions.push(await openSession(i));

    const buckets = sessions.map(() => []);
    handles.forEach((h, i) => buckets[i % buckets.length].push(h));

    await Promise.all(
      buckets.map(async (bucket, bi) => {
        const ctx = sessions[bi];
        if (bi > 0) await sleep(6000 * bi); // 错峰启动
        for (let k = 0; k < bucket.length; k++) {
          const handle = bucket[k];
          if (k > 0) await sleep(3000); // 同槽位账号之间留冷却

          let done = null;
          for (let attempt = 1; attempt <= attempts && !done; attempt++) {
            onEvent({ type: 'account-start', handle, attempt });
            try {
              const r = await scrapeAccount(ctx, handle, {
                from: opts.from,
                to: opts.to,
                maxScrolls: opts.maxScrolls,
                onProgress: (p) => onEvent({ type: 'account-progress', handle, ...p }),
              });
              if (r.apiCalls > 0) done = r;
              else if (attempt < attempts) {
                onEvent({ type: 'account-retry', handle, attempt, reason: 'TikTok 未返回数据，重试中' });
                await sleep(8000 * attempt);
              } else done = r;
            } catch (e) {
              const msg = e.message || String(e);
              if (attempt >= attempts) {
                onEvent({ type: 'account-error', handle, error: msg });
                done = { handle, nickname: '', stats: {}, items: [], apiCalls: 0, error: msg };
              } else {
                onEvent({ type: 'account-retry', handle, attempt, reason: msg });
                await sleep(8000 * attempt);
              }
            }
          }
          if (done) {
            onEvent({ type: 'account-done', handle, count: done.items.length, stats: done.stats });
            results.push(done);
          }
        }
      })
    );
  } finally {
    await Promise.all(sessions.map((c) => c.close().catch(() => {})));
  }
  return handles.map((h) => results.find((r) => r.handle === h)).filter(Boolean);
}

module.exports = {
  openSession,
  scrapeAccount,
  scrapeMany,
  resolveChromePath,
  ENGINE,
  get engine() {
    return ENGINE;
  },
};

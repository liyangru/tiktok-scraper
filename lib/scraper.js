/**
 * TikTok 抓取引擎
 *
 * 原理：用真实浏览器打开主页，拦截 TikTok 自己发出的 /api/post/item_list 响应，
 * 直接取原始 JSON（含播放/点赞/评论/分享/收藏/时长/话题标签）。
 *
 * 引擎：patchright —— Playwright 的反检测补丁版，修掉了 CDP 指纹泄漏。
 *   （2.1 起去掉了 playwright-core 兜底：它无头会被 TikTok 拦下，兜底也抓不到数据，白占 14MB。）
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
const pw = require('patchright');
const ENGINE = 'patchright';

/**
 * ⚠️ UA 必须和**真实浏览器**一致（平台 + 版本），否则 TikTok 判定为伪造客户端，直接返回空数据。
 * 踩过的坑：原来写死 Windows UA，但 macOS 上跑的是 macOS 的 Chromium —— 请求 URL 里
 * browser_platform=MacIntel 与 UA 里的 "Windows NT 10.0" 自相矛盾，/api/post/item_list
 * 返回 200 但响应体为空，页面上一个视频都没有 → 表现就是「抓不到数据」。
 * 而且 UA 里的 Chrome/140 也和自带浏览器的实际版本（156）对不上，属于第二处破绽。
 * 所以这里按运行平台生成 UA，版本号从自带浏览器二进制里读。
 */
function detectChromeVersion() {
  try {
    const exe = resolveChromePath();
    if (!exe) return null;
    const out = require('child_process').execFileSync(exe, ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = String(out).match(/(\d+\.\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

const CHROME_VERSION = detectChromeVersion() || '140.0.0.0';
const UA_PLATFORM =
  process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
const UA = `Mozilla/5.0 (${UA_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

const PROFILE_ROOT = process.env.PROFILE_DIR || path.join(process.env.TT_BASE_DIR || path.join(__dirname, '..'), 'data', 'profiles');

/**
 * 定位抓取用的浏览器。
 *
 * ⚠️ 硬约束（用户要求）：**只用程序自带的 Chromium，绝不碰系统安装的 Chrome / Edge**。
 * 理由：别人的机器上系统浏览器版本五花八门（甚至没有），一旦偷偷用了系统浏览器，
 * 「干净环境能跑」就变成了「装了 Chrome 才能跑」，交付标准直接失守。
 * 所以候选只有两条：
 *   1) CHROME_PATH —— 由 lib/browsers.js 解压自带载荷后写入（Electron 里必然指向自带 Chromium）
 *   2) <BASE_DIR>/browsers/… —— 直接扫一遍，防止 env 丢失
 *   3) 引擎自带目录（patchright/playwright 下载的 Chromium）
 * 都找不到就返回 null —— 宁可明确报错，也不静默切到系统浏览器。
 */
function resolveChromePath() {
  const cands = [];
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH);
  const base = process.env.TT_BASE_DIR || path.join(__dirname, '..');
  cands.push(path.join(base, 'browsers'));
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) {
        const st = fs.statSync(c);
        if (st.isFile()) return c;
        // 目录 → 用统一的跨平台探测（lib/browsers.js）
        const found = require('./browsers').findChromium(c);
        if (found) return found;
      }
    } catch (e) {}
  }
  // 引擎自带（patchright/playwright 自己下载的 Chromium）—— 仍属于「自带载荷」
  try {
    const p = pw.chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 用户主动停止任务时抛出的错误（与「抓取失败」区分开，界面要显示「已停止」而不是「失败」） */
class AbortError extends Error {
  constructor() {
    super('任务已停止');
    this.name = 'AbortError';
  }
}
const isAbort = (e) => !!e && e.name === 'AbortError';
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new AbortError();
}
/** 可被停止打断的等待：每 250ms 检查一次 */
async function waitFor(ms, signal) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    throwIfAborted(signal);
    await sleep(Math.min(250, end - Date.now()));
  }
  throwIfAborted(signal);
}

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
  const headless = process.env.BROWSER_HEADLESS === '1';

  const opts = {
    headless,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    viewport: { width: 1366, height: 900 },
    userAgent: UA,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--lang=th-TH',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  };
  // ⚠️ 修复「抓取时弹出一个浏览器窗口」：
  // 1) 无头模式下绝不传 --window-position / --window-size —— 它们会让 Chromium
  //    在部分平台先创建可见窗口再隐藏，表现为闪一下/常驻一个空窗。
  // 2) 显式 --headless=new，避免老 headless 模式的窗口残留。
  // 3) 有头模式（仅手动调试）才保留窗口位置。
  if (headless) {
    opts.args.push('--headless=new');
  } else {
    opts.args.push(`--window-position=${x},${y}`, '--window-size=1000,820');
  }
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
 * @param {object} opts { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', maxScrolls, onProgress, onStage, signal }
 *   onStage(stage) 只在真实执行到对应步骤时触发：open → profile → scroll → filter
 *   返回值里的 complete / oldestDate 说明这次真正加载到了多早的数据（周期对比判断「数据是否充足」用）
 */
async function scrapeAccount(ctx, handle, opts = {}) {
  const from = opts.from ? new Date(opts.from + 'T00:00:00+07:00') : null;
  const to = opts.to ? new Date(opts.to + 'T23:59:59+07:00') : null;
  const maxScrolls = opts.maxScrolls || 400;
  const onProgress = opts.onProgress || (() => {});
  const onStage = opts.onStage || (() => {});
  const signal = opts.signal;
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
        // 真实进度：已经往回加载到哪一天（第一批可能混入置顶视频，不算），占「结束日期 → 需要加载到的日期」的比例
        let cover = null;
        let reached = null;
        if (batchIndex > 1 && Number.isFinite(lastBatchOldest)) {
          reached = new Date(lastBatchOldest * 1000 + 7 * 3600 * 1000).toISOString().slice(0, 10);
          const endTs = to ? Math.min(Math.floor(to.getTime() / 1000), Math.floor(Date.now() / 1000)) : Math.floor(Date.now() / 1000);
          if (Number.isFinite(stopBefore) && endTs > stopBefore) cover = Math.max(0, Math.min(1, (endTs - lastBatchOldest) / (endTs - stopBefore)));
        }
        if (!hasMore) cover = 1;
        onProgress({ found: items.size, batch: apiCalls, reached, cover });
      }
    } catch (e) {}
  });

  const url = `https://www.tiktok.com/@${handle}`;
  // 停止任务时立即关页面，正在进行的 goto 会随之抛错，不必干等 90 秒超时
  const onAbort = () => page.close().catch(() => {});
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    throwIfAborted(signal);
    onStage('open');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await waitFor(14000, signal);

    if (process.env.SCRAPER_DEBUG === '1') {
      const info = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        bodyLen: document.body ? document.body.innerText.length : 0,
      }));
      onProgress({ debug: `页面: ${JSON.stringify(info)}` });
    }

    onStage('profile');
    const prof = await readProfile(page);
    if (!prof) {
      await page.close();
      throw new Error(`找不到账号 @${handle}（可能不存在、被封禁或改名）`);
    }

    onStage('scroll');
    let stable = 0;
    let last = -1;
    for (let i = 0; i < maxScrolls; i++) {
      throwIfAborted(signal);
      await page.evaluate(() => {
        window.scrollBy(0, 2200);
        const sc = document.scrollingElement || document.documentElement;
        if (sc.scrollTop + window.innerHeight >= sc.scrollHeight - 50) sc.scrollTop = sc.scrollHeight;
      });
      await waitFor(2000, signal);

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
    onStage('filter');

    // 数据覆盖：要么 TikTok 说没有更多了，要么已经滚到早于起始日期的视频 —— 否则区间前段可能缺数据
    const fromTs = from ? Math.floor(from.getTime() / 1000) : -Infinity;
    const complete = !hasMore || (batchIndex > 1 && lastBatchOldest < fromTs);
    const oldestTs = batchIndex > 1 && Number.isFinite(lastBatchOldest) ? lastBatchOldest : null;
    const oldestDate = oldestTs ? new Date(oldestTs * 1000 + 7 * 3600 * 1000).toISOString().slice(0, 10) : null;

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

    return { handle, nickname: prof.user.nickname, user: prof.user, stats: prof.stats, items: list, apiCalls, complete, oldestDate };
  } catch (e) {
    if (signal && signal.aborted) throw new AbortError();
    throw e;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}

/**
 * 批量抓取
 *
 * ⚠️ 并发实现要点：每个并发槽位用**独立的持久化配置目录**。
 *    实测同一浏览器开多个标签页时后台页被节流；即使独立进程 + 窗口错位 + 错峰，
 *    第二个账号仍拿不到数据 → 所以默认 CONCURRENCY=1 顺序执行。
 *
 * @param {string[]} handles
 * @param {object} opts { from, to, concurrency, onEvent, attempts, signal }
 * 事件：stage（含 handle 时是账号级阶段）/ account-start / account-progress / account-retry /
 *       account-error / account-done / account-stopped
 * 返回结果数组；被停止时数组上带 aborted = true（已完成账号的结果照常返回）
 */
async function scrapeMany(handles, opts = {}) {
  const concurrency = Math.max(1, Math.min(opts.concurrency || 1, 3));
  const attempts = Math.max(1, Math.min(opts.attempts || 3, 5));
  const onEvent = opts.onEvent || (() => {});
  const signal = opts.signal;
  const results = [];
  const sessions = [];
  let aborted = false;
  const closeAll = () => Promise.all(sessions.map((c) => c.close().catch(() => {})));
  if (signal) signal.addEventListener('abort', closeAll, { once: true });

  try {
    throwIfAborted(signal);
    onEvent({ type: 'stage', stage: 'launch' });
    for (let i = 0; i < Math.min(concurrency, handles.length); i++) {
      sessions.push(await openSession(i));
      throwIfAborted(signal);
    }

    const buckets = sessions.map(() => []);
    handles.forEach((h, i) => buckets[i % buckets.length].push(h));

    await Promise.all(
      buckets.map(async (bucket, bi) => {
        const ctx = sessions[bi];
        if (bi > 0) await waitFor(6000 * bi, signal); // 错峰启动
        for (let k = 0; k < bucket.length; k++) {
          const handle = bucket[k];
          if (aborted || (signal && signal.aborted)) {
            aborted = true;
            onEvent({ type: 'account-stopped', handle });
            continue;
          }
          if (k > 0) await waitFor(3000, signal).catch(() => {}); // 同槽位账号之间留冷却
          if (signal && signal.aborted) {
            aborted = true;
            onEvent({ type: 'account-stopped', handle });
            continue;
          }

          let done = null;
          for (let attempt = 1; attempt <= attempts && !done; attempt++) {
            onEvent({ type: 'account-start', handle, attempt });
            try {
              const r = await scrapeAccount(ctx, handle, {
                from: opts.from,
                to: opts.to,
                maxScrolls: opts.maxScrolls,
                signal,
                onStage: (stage) => onEvent({ type: 'stage', handle, stage }),
                onProgress: (p) => onEvent({ type: 'account-progress', handle, ...p }),
              });
              if (r.apiCalls > 0) done = r;
              else if (attempt < attempts) {
                onEvent({ type: 'account-retry', handle, attempt, reason: 'TikTok 未返回数据，重试中' });
                await waitFor(8000 * attempt, signal);
              } else done = r;
            } catch (e) {
              if (isAbort(e) || (signal && signal.aborted)) {
                aborted = true;
                onEvent({ type: 'account-stopped', handle });
                break;
              }
              const msg = e.message || String(e);
              if (attempt >= attempts) {
                onEvent({ type: 'account-error', handle, error: msg });
                done = { handle, nickname: '', stats: {}, items: [], apiCalls: 0, error: msg };
              } else {
                onEvent({ type: 'account-retry', handle, attempt, reason: msg });
                try {
                  await waitFor(8000 * attempt, signal);
                } catch (_) {
                  aborted = true;
                  onEvent({ type: 'account-stopped', handle });
                  break;
                }
              }
            }
          }
          if (done) {
            onEvent({ type: 'account-done', handle, count: done.items.length, stats: done.stats, error: done.error || '', complete: done.complete !== false });
            results.push(done);
          }
        }
      })
    );
  } catch (e) {
    if (!(isAbort(e) || (signal && signal.aborted))) throw e;
    aborted = true;
    for (const h of handles) if (!results.some((r) => r.handle === h)) onEvent({ type: 'account-stopped', handle: h });
  } finally {
    if (signal) signal.removeEventListener('abort', closeAll);
    await closeAll();
  }
  const out = handles.map((h) => results.find((r) => r.handle === h)).filter(Boolean);
  if (aborted) out.aborted = true;
  return out;
}

module.exports = {
  openSession,
  scrapeAccount,
  scrapeMany,
  resolveChromePath,
  AbortError,
  isAbort,
  UA, // ⚠️ 播放地址与这个 UA 绑定，下载时必须用同一个，否则 CDN 403
  ENGINE,
  get engine() {
    return ENGINE;
  },
};

/**
 * 模块：TikTok 账号登录（常驻会话版）
 *
 * 设计要点（对比第一版的问题）：
 *   ① **常驻会话**：浏览器只启动一次并保持，状态查询是即时的 —— 不再每次冷启动（原来要 10~40 秒）
 *   ② **非阻塞启动**：/start 立即返回，真正的加载在后台跑，前端轮询 /state 看进度
 *   ③ **细粒度状态**：启动中 → 加载页 → 等待扫码 → 已扫码待确认 → 需要验证码/密码 → 成功/失败
 *   ④ **扫码后可继续输入**：TikTok 扫码后常要求邮箱/短信验证码或密码，/submit 把输入填进去继续
 *
 * 全程无头（不弹窗）；登录态存 data/profiles-tiktok/<账号名>，支持多账号。
 *
 * ⚠️ Round 14 修掉的三个「登录了等于没登录」的 bug（用户实测反馈）：
 *   ① 账号注册表**永远写不进去** —— 老代码 `addAccount` 开头就 `if (name === 'default') return`，
 *      而默认档案就叫 default，于是登录成功也一条账号都不记 → 「账号管理里看不到」。
 *   ② `/state` 只报**内存状态** —— 进程重启（或宿主重开）后 phase 回到 idle，
 *      明明磁盘里有登录态却报「未登录」→ 「没有登录态」。
 *   ③ 创作中心采集用 `firstProfileWithSession()` 找账号，而它只读注册表，
 *      注册表又是空的 → 登录成功后立刻报「还没有登录态，请先登录创作中心」→ 「没看到抓数据」。
 *   现在：注册表存对象（兼容老的字符串数组）、登录后从 passport 接口拿到真实 @handle 当标签、
 *   `/state` 无内存会话时回落到磁盘探测、账号支持切换/退出/删除。
 */
const fs = require('fs');
const path = require('path');

const QR_URL = 'https://www.tiktok.com/login/qrcode';
const PWD_URL = 'https://www.tiktok.com/login/phone-or-email/email';

/** 单会话状态机 */
const S = {
  phase: 'idle', // idle | launching | loading | waiting-scan | scanned | need-input | logged-in | error
  message: '',
  qr: '',
  inputKind: '', // '' | 'code' | 'password' | 'account'
  account: '',
  at: 0,
};

let ctxRef = null;
let pageRef = null;
let profileName = 'default';
let ticker = null;

const set = (phase, message, extra) => {
  S.phase = phase;
  S.message = message || '';
  Object.assign(S, extra || {});
  S.at = Date.now();
};

/* ==================== 账号注册表 ====================
   存储 data/profiles-tiktok-accounts.json
   新格式：{ active, accounts: [{ id, label, account, handle, lastLoginAt }] }
   旧格式：{ accounts: ['default', 'xxx'] } —— 读到自动升级，老用户登录态不丢。 */

function accountsFile(ctx) {
  return path.join(ctx.baseDir, 'data', 'profiles-tiktok-accounts.json');
}

function writeRegistry(ctx, data) {
  try {
    fs.mkdirSync(path.dirname(accountsFile(ctx)), { recursive: true });
    fs.writeFileSync(accountsFile(ctx), JSON.stringify(data, null, 2));
  } catch (_) {}
}

/** 读注册表（统一成对象数组；老字符串数组就地升级） */
function readRegistry(ctx) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(accountsFile(ctx), 'utf8'));
  } catch (_) {
    raw = null;
  }
  const list = raw && Array.isArray(raw.accounts) ? raw.accounts : [];
  const accounts = list
    .map((a) => {
      if (typeof a === 'string') return { id: a, label: a === 'default' ? '' : a, account: '', handle: '', lastLoginAt: '' };
      if (a && typeof a === 'object' && a.id) {
        return {
          id: String(a.id),
          label: a.label || '',
          account: a.account || '',
          handle: a.handle || '',
          lastLoginAt: a.lastLoginAt || '',
        };
      }
      return null;
    })
    .filter(Boolean);
  return { active: (raw && raw.active) || (accounts[0] && accounts[0].id) || '', accounts };
}

/** 新增或更新一个账号条目；**不再跳过 default**（这正是老代码的 bug） */
function upsertAccount(ctx, id, patch) {
  if (!id) return;
  const reg = readRegistry(ctx);
  let one = reg.accounts.find((a) => a.id === id);
  if (!one) {
    one = { id, label: '', account: '', handle: '', lastLoginAt: '' };
    reg.accounts.push(one);
  }
  if (patch) {
    // ⚠️ 这里判断的是「键有没有传」，不是「值是不是空」——
    //    退出登录时要真的把 handle/account 清空，否则账号管理里还挂着 @handle、
    //    登录态却显示未登录，看起来像坏了。
    if (patch.label !== undefined && patch.label !== '') one.label = patch.label;
    if (patch.account !== undefined) one.account = patch.account;
    if (patch.handle !== undefined) one.handle = patch.handle;
    if (patch.lastLoginAt !== undefined) one.lastLoginAt = patch.lastLoginAt;
  }
  if (!reg.active) reg.active = id;
  writeRegistry(ctx, reg);
  return one;
}

function removeAccount(ctx, id) {
  const reg = readRegistry(ctx);
  reg.accounts = reg.accounts.filter((a) => a.id !== id);
  if (reg.active === id) reg.active = (reg.accounts[0] && reg.accounts[0].id) || '';
  writeRegistry(ctx, reg);
  return reg;
}

/** 保存的登录凭据（存了密码的账号以后无头自动登录，失败才弹有头窗） */
function credsFile(ctx) {
  return path.join(ctx.baseDir, 'data', 'tiktok-creds.json');
}
function readCreds(ctx) {
  try {
    return JSON.parse(fs.readFileSync(credsFile(ctx), 'utf8'));
  } catch (_) {
    return {};
  }
}
function saveCreds(ctx, name, account, password) {
  if (!name || !account || !password) return;
  const all = readCreds(ctx);
  all[name] = { account, p: Buffer.from(String(password), 'utf8').toString('base64') };
  fs.mkdirSync(path.dirname(credsFile(ctx)), { recursive: true });
  fs.writeFileSync(credsFile(ctx), JSON.stringify(all, null, 2));
}
function getCreds(ctx, name) {
  const c = readCreds(ctx)[name];
  if (!c || !c.p) return null;
  return { account: c.account, password: Buffer.from(c.p, 'base64').toString('utf8') };
}

function profileDir(ctx, name) {
  const d = path.join(ctx.baseDir, 'data', 'profiles-tiktok', name || 'default');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 登录态判断（磁盘）：Chromium 把 Cookie 放在 Default/Network/Cookies（新版）
 * 或 Default/Cookies（老版）。文件存在且非空才算有登录态。
 */
function hasSession(ctx, name) {
  const root = path.join(ctx.baseDir, 'data', 'profiles-tiktok', name || 'default');
  for (const rel of ['Default/Network/Cookies', 'Default/Cookies']) {
    try {
      const p = path.join(root, rel);
      if (fs.existsSync(p) && fs.statSync(p).size > 0) return true;
    } catch (_) {}
  }
  return false;
}

/** 列出磁盘上所有存在登录态的档案目录名（注册表丢了也能找回来） */
function scanProfileDirs(ctx) {
  try {
    const root = path.join(ctx.baseDir, 'data', 'profiles-tiktok');
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => hasSession(ctx, n));
  } catch (_) {
    return [];
  }
}

/** 在页面与所有 frame 里找二维码 */
async function findQr(page) {
  const frames = [page.mainFrame()].concat(page.frames());
  for (const f of frames) {
    for (const sel of ['img[src^="data:image"]', 'canvas', 'img[class*="qr"]', '[class*="qrcode"] img', '[class*="qr-code"] img']) {
      try {
        const el = await f.$(sel);
        if (el) {
          const box = await el.boundingBox();
          if (box && box.width >= 120 && box.height >= 120) return el;
        }
      } catch (_) {}
    }
  }
  return null;
}

/** 读页面上的可见文案（判断走到哪一步） */
async function pageText(page) {
  try {
    return await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('div,span,p,h1,h2,h3,button,label').forEach((e) => {
        if (e.children.length) return;
        const t = (e.textContent || '').trim();
        if (t && t.length <= 60) out.push(t);
      });
      return out.join(' | ');
    });
  } catch (_) {
    return '';
  }
}

const isLoggedInUrl = (u) => !!u && !/\/login/i.test(u) && !/^about:blank/.test(u);

/**
 * 更可靠的登录判定。
 * ⚠️ 用户实测：手机上确认后页面**会有一段时间仍停在 /login**（异步换 session），
 *    只靠 URL 会「确认了但界面没反应」。所以三条任一成立就算登录成功：
 *    ① URL 离开登录页 ② 拿到 sessionid/sessionid_ss cookie ③ 页面上出现已登录元素
 */
async function isLoggedIn(ctxRef, page) {
  try {
    const url = page.url();
    if (isLoggedInUrl(url)) return true;
  } catch (_) {}
  try {
    const cookies = await ctxRef.cookies('https://www.tiktok.com');
    if (cookies.some((c) => /^(sessionid|sessionid_ss|sid_tt)$/.test(c.name) && c.value)) return true;
  } catch (_) {}
  try {
    const hasAvatar = await page.evaluate(() => {
      return !!(
        document.querySelector('[data-e2e="profile-icon"], [data-e2e="nav-profile"], img[class*="avatar"], [class*="Avatar"]')
      );
    });
    if (hasAvatar) return true;
  } catch (_) {}
  return false;
}

/**
 * 拿登录账号的真实 @handle。
 * 首选 TikTok 自己的 passport 接口（带 Cookie 请求，返回的就是当前登录账号），
 * 拿不到再退回页面抓取 —— 绝不用 URL/头像瞎猜（那是别人的号）。
 */
async function detectHandle(page) {
  try {
    const j = await page.evaluate(async () => {
      try {
        const r = await fetch('https://www.tiktok.com/passport/web/account/info/?aid=1988', {
          credentials: 'include',
        });
        return await r.json();
      } catch (_) {
        return null;
      }
    });
    const u = j && j.data && (j.data.username || j.data.unique_id || j.data.display_name);
    if (u && /^[A-Za-z0-9._]{2,40}$/.test(String(u).trim())) return String(u).trim();
  } catch (_) {}
  try {
    return await page.evaluate(() => {
      const el = document.querySelector('[data-e2e="profile-username"], [data-e2e="profile-icon"]');
      const txt = el ? String(el.textContent || '').trim().replace(/^@/, '') : '';
      return /^[A-Za-z0-9._]{2,40}$/.test(txt) ? txt : '';
    });
  } catch (_) {
    return '';
  }
}

/** 提交时暂存的凭据：等 ticker 确认登录成功后才真正落盘（失败的密码不存） */
let pendingCreds = null;

/** 后台心跳：每 1.5 秒刷新阶段（「不卡顿」的关键 —— 状态永远最新） */
function startTicker(ctx) {
  if (ticker) clearInterval(ticker);
  ticker = setInterval(async () => {
    if (!pageRef || !ctxRef) return;
    try {
      if (await isLoggedIn(ctxRef, pageRef)) {
        // 拿到真实 handle 再登记，账号管理里才是有意义的账号名（不是又一个 default）
        const handle = await detectHandle(pageRef).catch(() => '');
        upsertAccount(ctx, profileName, {
          handle,
          account: handle ? '@' + handle : '',
          label: handle ? '@' + handle : profileName === 'default' ? 'TikTok 账号' : profileName,
          lastLoginAt: new Date().toISOString(),
        });
        if (pendingCreds) {
          saveCreds(ctx, profileName, pendingCreds.account, pendingCreds.password);
          ctx.log(`已保存「${profileName}」的登录凭据，以后自动无头登录`);
          pendingCreds = null;
        }
        set('logged-in', handle ? `登录成功：@${handle}` : '登录成功', { account: profileName, handle });
        // 登录成功后自动关窗（用户要求：不要常驻浏览器窗口）
        setTimeout(() => closeSession().catch(() => {}), 1500);
        return;
      }
      const txt = await pageText(pageRef);
      if (/验证码|verification code|รหัสยืนยัน/i.test(txt) && !/扫码|scan/i.test(txt)) {
        const hasPwd = await pageRef.$('input[type=password]').catch(() => null);
        set('need-input', hasPwd ? '需要在页面上补充密码' : '需要输入验证码（查看手机短信或邮箱）', {
          inputKind: hasPwd ? 'password' : 'code',
        });
        return;
      }
      if (/扫描成功|已扫描|请在手机|confirm on your phone|ยืนยันบนมือถือ|scan success/i.test(txt)) {
        set('scanned', '已扫码 —— 请在手机上点确认');
        return;
      }
      if (S.phase !== 'waiting-scan' && S.phase !== 'scanned' && S.phase !== 'need-input') {
        const qr = await findQr(pageRef);
        if (qr) {
          try {
            const shot = await qr.screenshot();
            set('waiting-scan', '请用手机 TikTok 扫码', { qr: shot.toString('base64'), inputKind: '' });
          } catch (_) {
            set('waiting-scan', '请用手机 TikTok 扫码');
          }
        }
      }
    } catch (_) {}
  }, 1500);
}

async function ensureSession(ctx, name, forceVisible) {
  profileName = name || profileName || 'default';
  if (ctxRef) return ctxRef;
  const chromium = ctx.core.chromium;
  if (!chromium) throw new Error('核心没有提供 chromium');
  const exe = ctx.core.scraper.resolveChromePath();
  /**
   * 首次登录必须**有头**（TikTok 对无头会话不完成登录，用户实测扫码后无反应）；
   * 已经有登录态（profile 里存了 Cookies）时走无头，避免每次都弹窗。
   * forceVisible = 无头自动登录失败后的兜底：再弹有头窗让人处理（Round 6 用户要求）。
   */
  const logged = hasSession(ctx, profileName);
  ctxRef = await chromium.launchPersistentContext(profileDir(ctx, profileName), {
    headless: forceVisible ? false : logged,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--disable-dev-shm-usage'],
    ...(exe ? { executablePath: exe } : {}),
  });
  ctxRef.on('close', () => {
    ctxRef = null;
    pageRef = null;
    if (ticker) clearInterval(ticker);
    ticker = null;
    if (S.phase !== 'logged-in') set('idle', '');
  });
  return ctxRef;
}

async function closeSession() {
  if (ticker) clearInterval(ticker);
  ticker = null;
  const c = ctxRef;
  ctxRef = null;
  pageRef = null;
  if (c) await c.close().catch(() => {});
}

/* ==================== 创作中心数据采集 ====================
   ⚠️ 创作中心没有公开文档，接口路径会随版本改。之前写死了两个猜的 REST 端点，
   端点一改就永远拿不到数据（而且静默跳过）。现在改成：
   **打开创作中心页面，监听它自己发出的 JSON 响应**，从任意响应里把数据收下来。

   实测（2026-10，账号 loop.earplugs.offi）确认了两件事：
   ① `POST /tiktok/creator/manage/item_list/v1/` 返回的 item_list 只有
      play_count / like_count / comment_count / share_count / favorite_count ——
      全都是 TikTok 抓取已有的字段。按「TikTok 抓取为准」的原则，逐条视频**不需要**
      从创作中心补任何东西，真正独有的是下面这个。
   ② `/aweme/v2/data/insight/` 返回**账号级日度历史**：播放(vv_history)、点赞、评论、
      分享、粉丝总数、净增粉丝、主页访问、触达人数，以及创作中心独有的
      video_finish_rate_history_7d（完播率历史）、video_new_followers_history_7d 等。
      这才是「趋势」该用的数据来源 —— 也是用户说的「要用创作中心的数据」。 */

const insightFile = (ctx) => path.join(ctx.baseDir, 'data', 'creator-sync', 'insight.json');

function readInsight(ctx) {
  try {
    return JSON.parse(fs.readFileSync(insightFile(ctx), 'utf8'));
  } catch (_) {
    return null;
  }
}
function writeInsight(ctx, data) {
  try {
    fs.mkdirSync(path.dirname(insightFile(ctx)), { recursive: true });
    fs.writeFileSync(insightFile(ctx), JSON.stringify(data));
  } catch (_) {}
}

/** 从 insight 响应里挖出所有「历史序列」+ 几个标量 */
function harvestInsight(j, out) {
  if (!j || typeof j !== 'object') return;
  for (const [k, v] of Object.entries(j)) {
    if (!Array.isArray(v) || v.length < 2) continue;
    if (!/(_history|_7d|_48_hours)$/.test(k)) continue;
    const nums = v
      .map((x) => (x && typeof x === 'object' ? Number(x.value) : Number(x)))
      .filter((n) => Number.isFinite(n));
    if (nums.length >= 2) {
      // 同一序列可能出现多次（7 天/16 天两种窗口），保留更长的那个
      if (!out.series[k] || out.series[k].length < nums.length) out.series[k] = nums;
    }
  }
  if (typeof j.follower_num === 'number') out.meta.followers = j.follower_num;
  if (typeof j.unique_viewer_num === 'number') out.meta.uniqueViewer = j.unique_viewer_num;
  // 流量来源：原始形态是 { status, value: [{key, str_value, value}] }，这里直接归一成 [{key, pct}]
  const tp = j.video_page_percent;
  if (tp && Array.isArray(tp.value)) {
    const list = tp.value
      .filter((x) => x && x.key)
      .map((x) => ({ key: x.key, pct: Math.round((Number(x.value) || 0) * 1000) / 10 }));
    if (list.length && list.length >= ((out.meta.traffic || []).length || 0)) out.meta.traffic = list;
  }
  if (Array.isArray(j.user_search_terms)) {
    const terms = j.user_search_terms
      .map((x) => (x && (x.word || x.query || x.value)) || (typeof x === 'string' ? x : ''))
      .filter(Boolean);
    if (terms.length) out.meta.searchTerms = terms.slice(0, 8);
  }
}

/** 只保留创作中心独有的字段（播放/点赞等以 TikTok 抓取为准，核心会剔除，这里也先不取） */
async function collectCreator(ctx, name) {
  const target = name || currentSessionName(ctx);
  if (!target) return { ok: false, n: 0, error: '还没有登录态，请先登录创作中心' };
  const chromium = ctx.core.chromium;
  if (!chromium) return { ok: false, n: 0, error: '内置浏览器不可用' };
  const exe = ctx.core.scraper.resolveChromePath();
  let c = null;
  const acc = { series: {}, meta: {} };
  const tried = [];
  try {
    c = await chromium.launchPersistentContext(profileDir(ctx, target), {
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: ['--no-first-run', '--disable-dev-shm-usage', '--window-position=-32000,-32000'],
      ...(exe ? { executablePath: exe } : {}),
    });
    const page = c.pages()[0] || (await c.newPage());
    page.on('response', async (r) => {
      try {
        const u = r.url();
        if (!/tiktok\.com/i.test(u)) return;
        if (!/insight|creator|studio|analytics/i.test(u)) return;
        if (/\.(js|css|png|jpe?g|webp|svg|woff2?|mp4|ico)(\?|$)/i.test(u)) return;
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        if (ct && !/json/.test(ct)) return;
        const j = await r.json().catch(() => null);
        if (j) harvestInsight(j, acc);
      } catch (_) {}
    });

    // 创作中心的数据页（实测 /tiktokstudio/analytics 才会发 insight 请求；
    // /creator-center 会 302 到 /tiktokstudio 首页，数据量少）
    for (const url of [
      'https://www.tiktok.com/tiktokstudio/analytics',
      'https://www.tiktok.com/creator-center',
    ]) {
      if (Object.keys(acc.series).length) break;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(12000); // 等页面把 insight 接口打完
        if (/\/login/i.test(page.url())) {
          tried.push(`${url} → 被重定向到登录页（登录态已失效）`);
          break;
        }
        tried.push(`${url} → ${Object.keys(acc.series).length} 条序列`);
      } catch (e) {
        tried.push(`${url} → ${e.message}`);
      }
    }

    const n = Object.keys(acc.series).length;
    if (!n) {
      return { ok: false, n: 0, error: '创作中心没有返回可用的数据（登录态可能已失效）', detail: tried.join(' | ') };
    }
    acc.at = Date.now();
    acc.account = target;
    acc.handle = await detectHandle(page).catch(() => '');
    writeInsight(ctx, acc);
    return { ok: true, n, error: '', handle: acc.handle };
  } catch (e) {
    return { ok: false, n: 0, error: e.message };
  } finally {
    if (c) await c.close().catch(() => {});
  }
}

/** 当前应当用哪个账号：内存里的会话 → 注册表 active → 磁盘上随便一个有登录态的档案 */
function currentSessionName(ctx) {
  if (ctxRef && profileName) return profileName;
  const reg = readRegistry(ctx);
  const active = reg.accounts.find((a) => a.id === reg.active);
  if (active && hasSession(ctx, active.id)) return active.id;
  const any = reg.accounts.find((a) => hasSession(ctx, a.id));
  if (any) return any.id;
  return scanProfileDirs(ctx)[0] || null;
}

module.exports = {
  register(app, ctx) {
    const { log } = ctx;

    /**
     * 无头密码自动登录（Round 6）：存过凭据的账号先走这条路，失败了才弹有头窗。
     * 用独立临时上下文，成功就把登录态写进同一 profile 后关掉。
     */
    async function tryHeadlessPasswordLogin(name, creds) {
      const chromium = ctx.core.chromium;
      if (!chromium) return false;
      const exe = ctx.core.scraper.resolveChromePath();
      let c = null;
      try {
        c = await chromium.launchPersistentContext(profileDir(ctx, name), {
          headless: true,
          viewport: { width: 1280, height: 900 },
          args: ['--no-first-run', '--disable-dev-shm-usage', '--window-position=-32000,-32000'],
          ...(exe ? { executablePath: exe } : {}),
        });
        const page = c.pages()[0] || (await c.newPage());
        await page.goto(PWD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        const frames = [page.mainFrame()].concat(page.frames());
        const fill = async (sel, val) => {
          for (const f of frames) {
            try {
              const el = await f.$(sel);
              if (el) { await el.fill(String(val)); return true; }
            } catch (_) {}
          }
          return false;
        };
        await fill('input[name=username], input[name=email]', creds.account);
        await fill('input[type=password]', creds.password);
        for (const f of frames) {
          try { await f.click('button[type=submit]', { timeout: 2000 }); break; } catch (_) {}
        }
        for (let i = 0; i < 25; i++) {
          await page.waitForTimeout(1000);
          try {
            const cookies = await c.cookies('https://www.tiktok.com');
            if (cookies.some((ck) => /^(sessionid|sessionid_ss|sid_tt)$/.test(ck.name) && ck.value)) return true;
          } catch (_) {}
          if (page.url() && !/\/login/i.test(page.url())) return true;
        }
        return false;
      } catch (_) {
        return false;
      } finally {
        if (c) await c.close().catch(() => {});
      }
    }

    /** 开始登录：**立即返回**，后台加载；前端轮询 /state 看进度 */
    app.post('/api/tiktok-login/start', async (req, res) => {
      const account = String((req.body && req.body.account) || '').trim();
      const mode = (req.body && req.body.mode) === 'password' ? 'password' : 'qr';
      res.json({ ok: true, started: true });
      (async () => {
        try {
          // ① 存了凭据 → 先无头自动登录（不弹窗）；失败再降级有头窗（用户要求）
          const creds = account ? getCreds(ctx, account) : null;
          if (creds) {
            set('launching', '正在用保存的凭据无头自动登录…', { qr: '', inputKind: '', account });
            const ok = await tryHeadlessPasswordLogin(account, creds);
            if (ok) {
              upsertAccount(ctx, account, { lastLoginAt: new Date().toISOString() });
              set('logged-in', '已用保存的凭据自动登录（无头）', { account });
              return;
            }
            set('launching', '无头自动登录失败，转为打开登录窗口…', { account });
          }
          set('launching', '正在打开登录窗口…', { qr: '', inputKind: '', account });
          await closeSession();
          const c = await ensureSession(ctx, account, !!creds);
          set('loading', '正在打开登录页…');
          const page = c.pages()[0] || (await c.newPage());
          pageRef = page;
          startTicker(ctx);
          await page.goto(mode === 'qr' ? QR_URL : PWD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(2500);
          // 有些账号 profile 里已经有有效登录态 → 打开登录页会被直接弹回已登录页
          if (await isLoggedIn(ctxRef, page)) {
            const handle = await detectHandle(page).catch(() => '');
            upsertAccount(ctx, profileName, {
              handle,
              account: handle ? '@' + handle : '',
              label: handle ? '@' + handle : profileName,
              lastLoginAt: new Date().toISOString(),
            });
            set('logged-in', handle ? `登录态有效：@${handle}` : '登录态有效', { account: profileName, handle });
            setTimeout(() => closeSession().catch(() => {}), 1500);
            return;
          }
          if (mode === 'qr') {
            const qr = await findQr(page);
            if (qr) {
              const shot = await qr.screenshot();
              set('waiting-scan', '登录窗口已打开 —— 请用手机扫码，或改用账密登录', { qr: shot.toString('base64'), inputKind: '' });
            } else {
              set('waiting-scan', '登录窗口已打开 —— 请在窗口中完成登录', { qr: '', inputKind: '' });
            }
          } else {
            set('need-input', '请输入账号与密码后提交', { inputKind: 'account' });
          }
        } catch (e) {
          set('error', '打开登录页失败：' + e.message);
        }
      })();
    });

    /**
     * 状态查询（即时，不启动任何东西）。
     * ⚠️ 没有内存会话时**必须回落查磁盘** —— 否则进程重启后明明有登录态却显示未登录，
     *    用户看到的就是「登录了但没登录态」。
     */
    app.get('/api/tiktok-login/state', (req, res) => {
      let phase = S.phase;
      let message = S.message;
      let account = S.account;
      let saved = false;
      if (!ctxRef && (phase === 'idle' || phase === 'error' || !phase)) {
        const name = currentSessionName(ctx);
        if (name) {
          const reg = readRegistry(ctx);
          const one = reg.accounts.find((a) => a.id === name);
          phase = 'logged-in';
          account = name;
          saved = true;
          message = one && one.handle ? `登录态已保存：@${one.handle}` : '登录态已保存（上次登录仍在有效期内）';
        }
      }
      res.json({
        phase,
        message,
        qr: ctxRef ? S.qr : '',
        inputKind: S.inputKind,
        account,
        handle: S.handle || '',
        loggedIn: phase === 'logged-in',
        saved, // true = 来自磁盘的既有登录态，不是本次会话登录的
        since: S.at,
        open: !!ctxRef,
      });
    });

    /** 扫码后补充输入（验证码 / 密码 / 账号密码） */
    app.post('/api/tiktok-login/submit', async (req, res) => {
      const b = req.body || {};
      try {
        if (!pageRef) return res.status(400).json({ error: '会话已关闭，请重新开始' });
        const page = pageRef;
        const frames = [page.mainFrame()].concat(page.frames());
        const fill = async (sel, val) => {
          for (const f of frames) {
            try {
              const el = await f.$(sel);
              if (el) {
                await el.fill(String(val));
                return true;
              }
            } catch (_) {}
          }
          return false;
        };
        let acted = false;
        if (b.account) acted = (await fill('input[name=username], input[name=email], input[type=text]', b.account)) || acted;
        if (b.password) acted = (await fill('input[type=password]', b.password)) || acted;
        if (b.code) acted = (await fill('input[inputmode=numeric], input[name=code], input[type=text]', b.code)) || acted;
        if (!acted) return res.status(400).json({ error: '页面上找不到可填写的输入框（结构可能变了）' });
        // 账密提交 → 暂存，等登录真的成功（ticker 判定）后才落盘保存
        if (b.account && b.password) pendingCreds = { account: b.account, password: b.password };
        for (const f of frames) {
          try {
            await f.click('button[type=submit]', { timeout: 2000 });
            break;
          } catch (_) {}
        }
        set('loading', '已提交，正在验证…');
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    /** 关闭会话 / 退出（只关浏览器，不动登录态） */
    app.post('/api/tiktok-login/close', async (req, res) => {
      await closeSession();
      set('idle', '');
      res.json({ ok: true });
    });

    /**
     * 已登录账号列表 —— 与卖家中心模块**返回同一形状**，前端才能用同一套版式渲染。
     * ⚠️ 绝不能直接列 data/profiles-tiktok 下的目录 —— 那是 Chromium 的 user-data-dir，
     *    里面全是 ActorSafetyLists / CaptchaProviders 这类内部目录（踩过这个坑）。
     *    以注册表为准，但磁盘上多出来的档案（老版本登录过、注册表丢过）也补进来，
     *    否则用户会觉得「明明登录过却看不到账号」。
     */
    function listAccounts() {
      const reg = readRegistry(ctx);
      const ids = new Set(reg.accounts.map((a) => a.id));
      const extra = scanProfileDirs(ctx).filter((n) => !ids.has(n));
      const all = reg.accounts.concat(
        extra.map((id) => ({ id, label: id === 'default' ? 'TikTok 账号' : id, account: '', handle: '', lastLoginAt: '' }))
      );
      return {
        active: reg.active || (all[0] && all[0].id) || '',
        accounts: all.map((a) => ({
          id: a.id,
          label: a.label || a.account || a.id,
          account: a.account || '',
          handle: a.handle || '',
          hasSession: hasSession(ctx, a.id),
          lastLoginAt: a.lastLoginAt || '',
          current: a.id === (reg.active || (all[0] && all[0].id) || ''),
        })),
      };
    }

    app.get('/api/tiktok-login/accounts', (req, res) => res.json(listAccounts()));

    /** 切换当前账号（下一次登录/抓取用它的登录态） */
    app.post('/api/tiktok-login/accounts/:id/active', (req, res) => {
      const reg = readRegistry(ctx);
      upsertAccount(ctx, req.params.id, null);
      const reg2 = readRegistry(ctx);
      reg2.active = req.params.id;
      writeRegistry(ctx, reg2);
      profileName = req.params.id;
      res.json({ ok: true, ...listAccounts() });
    });

    /** 新建账号档案（多账号：每个档案一个独立登录态） */
    app.post('/api/tiktok-login/accounts', (req, res) => {
      const label = String((req.body && req.body.label) || '').trim();
      const rawId = String((req.body && req.body.id) || '').trim();
      const id = rawId || 'acc' + Date.now().toString(36);
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) return res.status(400).json({ error: '账号标识只能是字母/数字/._-' });
      upsertAccount(ctx, id, { label: label || id });
      res.json({ ok: true, id, ...listAccounts() });
    });

    /** 退出登录：删掉这个档案的登录态（下次要重新扫码） */
    app.post('/api/tiktok-login/accounts/:id/logout', async (req, res) => {
      const id = req.params.id;
      if (ctxRef && profileName === id) await closeSession();
      try {
        fs.rmSync(path.join(ctx.baseDir, 'data', 'profiles-tiktok', id), { recursive: true, force: true });
      } catch (_) {}
      upsertAccount(ctx, id, {
        handle: '',
        account: '',
        label: id === 'default' ? 'TikTok 账号' : id,
        lastLoginAt: '',
      });
      log(`创作中心账号「${id}」已退出登录`);
      set('idle', '');
      res.json({ ok: true, ...listAccounts() });
    });

    /** 删除账号条目（?purge=1 连档案一起删） */
    app.delete('/api/tiktok-login/accounts/:id', async (req, res) => {
      const id = req.params.id;
      if (ctxRef && profileName === id) await closeSession();
      if (req.query && String(req.query.purge) === '1') {
        try {
          fs.rmSync(path.join(ctx.baseDir, 'data', 'profiles-tiktok', id), { recursive: true, force: true });
        } catch (_) {}
      }
      removeAccount(ctx, id);
      res.json({ ok: true, ...listAccounts() });
    });

    /* ==================== 创作中心数据同步 ==================== */
    /* 登录成功后自动抓取一次（用户要求：登录了就该自动拿数据，失败要能重试） */
    app.post('/api/tiktok-login/sync-now', async (req, res) => {
      const r = await collectCreator(ctx, (req.body && req.body.id) || '');
      res.status(r.ok ? 200 : 500).json(r);
    });

    /**
     * 创作中心账号趋势（趋势图的数据来源之一）。
     * 由 collectCreator 从 /aweme/v2/data/insight/ 收下来，这里的 series 全是**真实日度序列**。
     */
    app.get('/api/tiktok-login/insight', (req, res) => {
      const d = readInsight(ctx);
      if (!d || !d.series || !Object.keys(d.series).length) {
        return res.json({ ok: false, series: {}, meta: {}, error: '还没有创作中心数据，请先登录创作中心（登录后会自动抓取）' });
      }
      res.json({ ok: true, at: d.at, account: d.account, handle: d.handle || '', series: d.series, meta: d.meta || {} });
    });

    /* ⚠️ 这里**故意不注册** registerSync：
       实测创作中心逐条视频只给 play/like/comment/share/favorite —— 全是 TikTok 抓取已有的字段，
       按「TikTok 抓取为准」的原则补进去没有任何意义。
       真正独有的数据（完播率历史、净增粉丝历史、流量来源）是**账号级**的，
       走 /api/tiktok-login/insight 给趋势图用，不往逐条视频上贴。 */

    log('创作中心数据导入模块已挂载：/api/tiktok-login/*（常驻会话 + 数据同步）');
  },
};

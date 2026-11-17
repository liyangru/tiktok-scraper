/**
 * 内置功能：卖家中心登录 / 数据导入（原 seller-import 模块，已并入应用）
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │ 🚨 数据原则（用户明确要求，改这里之前先想想）                  │
 * │   TikTok 数据为主，卖家中心只做补充 —— 绝不能反过来。          │
 * │   1. TikTok 抓到的 = 真实视频量（真实发布的视频清单）          │
 * │   2. 卖家中心只补「商家指标」：GMV / 订单 / 商品点击 / GPM …    │
 * │   3. 不能以卖家中心为主：里面混着大量广告计划/混剪视频          │
 * │   4. 匹配键 = 视频ID                                          │
 * │      匹配上 → 挂车；TikTok 有卖家中心没有 → 没挂车；           │
 * │      卖家中心有 TikTok 没有 → 广告/混剪，必须剔除             │
 * │   5. 挂车 vs 非挂车对比要在日期范围内做                        │
 * └──────────────────────────────────────────────────────────────┘
 *
 * 卖家中心导出（Video_Performance_List_*.xlsx）实测结构：
 *   第 1 行 = 日期范围（合并单元格），第 3 行 = 表头（30 列），第 4 行起 = 数据。
 *   解析时按「表头名」定位列，不按列序号 —— 卖家中心改列序也不怕。
 */
const fs = require('fs');
const captcha = require('./seller-captcha.js');
const path = require('path');

const SELLER_DIR_NAME = 'data' + path.sep + 'seller';

/** 表头别名 → 规范化键（卖家中心叫法 → 内部字段） */
const COL = {
  vid: ['视频ID', '视频id', 'Video ID'],
  author: ['达人昵称', '达人'],
  authorId: ['达人ID'],
  videoInfo: ['视频信息'],
  publishTime: ['发布时间'],
  product: ['商品'],
  vv: ['VV', '播放量'],
  likes: ['点赞数'],
  comments: ['评论数'],
  shares: ['分享数'],
  newFans: ['新增粉丝数'],
  leads: ['引流次数'],
  productImpressions: ['商品曝光次数'],
  productClicks: ['商品点击次数'],
  uniqueCustomers: ['去重客户数'],
  attributedOrders: ['归因 SKU 订单数'],
  videoOrders: ['视频 SKU 订单数'],
  indirectOrders: ['视频间接 SKU 订单数'],
  attributedUnits: ['视频归因成交件数'],
  productUnits: ['视频商品成交件数'],
  indirectUnits: ['视频间接成交件数'],
  attributedGmv: ['视频归因 GMV (฿)', '视频归因 GMV'],
  gmv: ['视频 GMV (฿)', '视频 GMV'],
  indirectGmv: ['视频间接 GMV (฿)', '视频间接 GMV'],
  gpm: ['GPM (฿)', 'GPM'],
  ctr: ['点击率（视频）', '点击率'],
  leadRate: ['引流率'],
  completionRate: ['视频完播率', '完播率'],
  ctor: ['CTOR（SKU 订单）', 'CTOR'],
};

/** 数字化：卖家中心导出的数字常带千分位/百分号/฿ */
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/[฿,\s%]/g, '').trim();
  if (s === '' || s === '-') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 解析卖家中心 xlsx → { dateRange, rows: [{vid, ...}], headerRow } */
function parseWorkbook(ctx, buf) {
  const ExcelJS = ctx.core.exceljs;
  const wb = new ExcelJS.Workbook();
  // 保留原样读：numFmt 里的百分号我们自己做
  return wb.xlsx.load(buf).then((book) => {
    const ws = book.worksheets[0];
    if (!ws) throw new Error('xlsx 里没有工作表');

    // 1) 找表头行：包含「视频ID」的那一行
    let headerRow = -1;
    const headers = [];
    for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
      const vals = [];
      ws.getRow(r).eachCell({ includeEmpty: false }, (c) => vals.push(String(c.value ?? '').trim()));
      if (vals.some((v) => COL.vid.includes(v))) {
        headerRow = r;
        headers.push(...vals);
        break;
      }
    }
    if (headerRow < 0) throw new Error('找不到表头（需要含「视频ID」列）。请确认是卖家中心的「视频表现」导出。');

    // 2) 表头名 → 列号
    const colOf = {};
    for (const [key, names] of Object.entries(COL)) {
      const i = headers.findIndex((h) => names.includes(h));
      if (i >= 0) colOf[key] = i + 1; // exceljs 列从 1 起
    }
    if (!colOf.vid) throw new Error('表头里没有「视频ID」列，无法匹配');

    // 3) 日期范围（第 1 行合并单元格里的文本）
    let dateRange = '';
    try {
      const c = ws.getCell('A1');
      dateRange = String(c.value?.richText ? c.value.richText.map((x) => x.text).join('') : c.value ?? '').trim();
      // 去掉「[日期范围]: 」这类标签前缀，只留日期区间
      const dr = /[:：]\s*(.+)$/.exec(dateRange);
      if (dr) dateRange = dr[1].trim();
    } catch (_) {}

    // 4) 数据行
    const rows = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (k) => (colOf[k] ? row.getCell(colOf[k]).value : null);
      const cellText = (k) => {
        const v = get(k);
        if (v === null || v === undefined) return '';
        if (v.richText) return v.richText.map((x) => x.text).join('');
        if (v.result !== undefined) return v.result; // 公式
        if (v.text) return v.text; // 超链接
        return v;
      };
      const vid = String(cellText('vid') || '').trim();
      if (!vid || !/^\d{6,}$/.test(vid)) continue; // 跳过空行/小计行
      rows.push({
        vid,
        author: String(cellText('author') || '').trim(),
        authorId: String(cellText('authorId') || '').trim(),
        videoInfo: String(cellText('videoInfo') || '').trim(),
        publishTime: String(cellText('publishTime') || '').trim(),
        product: String(cellText('product') || '').trim(),
        vv: toNum(cellText('vv')),
        likes: toNum(cellText('likes')),
        comments: toNum(cellText('comments')),
        shares: toNum(cellText('shares')),
        newFans: toNum(cellText('newFans')),
        leads: toNum(cellText('leads')),
        productImpressions: toNum(cellText('productImpressions')),
        productClicks: toNum(cellText('productClicks')),
        uniqueCustomers: toNum(cellText('uniqueCustomers')),
        attributedOrders: toNum(cellText('attributedOrders')),
        videoOrders: toNum(cellText('videoOrders')),
        indirectOrders: toNum(cellText('indirectOrders')),
        attributedUnits: toNum(cellText('attributedUnits')),
        productUnits: toNum(cellText('productUnits')),
        indirectUnits: toNum(cellText('indirectUnits')),
        attributedGmv: toNum(cellText('attributedGmv')),
        gmv: toNum(cellText('gmv')),
        indirectGmv: toNum(cellText('indirectGmv')),
        gpm: toNum(cellText('gpm')),
        ctr: toNum(cellText('ctr')),
        leadRate: toNum(cellText('leadRate')),
        completionRate: toNum(cellText('completionRate')),
        ctor: toNum(cellText('ctor')),
      });
    }
    return { dateRange, headerRow, rows };
  });
}

/* ================= 套壳：卖家中心浏览器 + 自动接住导出文件 ================= */

/**
 * 卖家中心有**两个域名**，账号属于哪个必须选对，否则就是「登录不上」：
 *   th     —— 泰国本地店  https://seller-th.tiktok.com
 *   global —— 跨境全球店  https://seller.tiktokshopglobalselling.com
 * ⚠️ 老代码把登录地址写死成 global，泰国本地店的账号在那边根本不存在，
 *    配上密码也只会一直失败 —— 用户反馈的「卖家中心也无法登录」就是这个。
 * 账号没标 site 时按账号串猜（loop.th@… → 泰国本地店），也可以手动改。
 */
const SELLER_SITES = {
  th: {
    login: 'https://seller-th.tiktok.com/account/login',
    home: 'https://seller-th.tiktok.com/compass/video-analytics/video-details',
  },
  global: {
    login: 'https://seller.tiktokshopglobalselling.com/account/login?platform_data_source=shop&shop_region=TH',
    home: 'https://seller.tiktokshopglobalselling.com/compass/video-analytics/video-details?platform_data_source=shop&shop_region=TH',
  },
};
function guessSite(account) {
  const a = String(account || '').toLowerCase();
  if (/\.th@|^th@|@th\./.test(a)) return 'th';
  return 'global';
}
const siteOf = (acc) => (acc && SELLER_SITES[acc.site] ? acc.site : guessSite(acc && acc.account));
const siteLoginUrl = (acc) => SELLER_SITES[siteOf(acc)].login;
/** autoLogin 手里只有账号字符串（没有账号对象），按字符串猜站点 */
const siteLoginUrlFromAccount = (account) => SELLER_SITES[guessSite(account)].login;
const siteHomeUrl = (acc) => SELLER_SITES[siteOf(acc)].home;

const DEFAULT_SELLER_URL = SELLER_SITES.global.home;

let sellerCtx = null;
/** 记录当前常驻上下文是不是无头 —— 决定「点登录」要不要重开一个可见窗口 */
let sellerCtxHeadless = null;

/** 接住页面里触发的下载 → 自动解析入库（与手动导入同一存储） */
function attachDownload(ctx, SELLER_DIR) {
  return (page) => {
    page.on('download', async (d) => {
      try {
        const dir = ensureDir(path.join(SELLER_DIR, 'downloads'));
        const file = path.join(dir, `compass-${Date.now()}.xlsx`);
        await d.saveAs(file);
        ctx.log(`接住卖家中心导出：${path.basename(file)}`);
        const parsed = await parseWorkbook(ctx, fs.readFileSync(file));
        if (!parsed.rows.length) {
          ctx.log('导出文件解析到 0 行，跳过入库');
          return;
        }
        const name = `${Date.now()}-${parsed.rows.length}.json`;
        fs.writeFileSync(
          path.join(SELLER_DIR, name),
          JSON.stringify({
            importedAt: new Date().toISOString(),
            dateRange: parsed.dateRange,
            source: 'compass-auto',
            rows: parsed.rows,
          })
        );
        ctx.log(`✅ 自动入库 ${parsed.rows.length} 条（${parsed.dateRange}），交叉分析可直接用`);
      } catch (e) {
        ctx.log(`处理导出文件失败：${e.message}`);
      }
    });
  };
}

/** 请求记录：把页面发出的 XHR 记下来，用于分析卖家中心的数据接口 */
let XHR_LOG = [];
const XHR_MAX = 400;

function attachXhrLog(page, ctx) {
  page.on('response', (r) => {
    try {
      const u = r.url();
      if (!/api|ajax|graphql|compass|analytics/i.test(u)) return;
      if (/\.(js|css|png|jpe?g|webp|svg|woff2?|mp4|ico)(\?|$)/i.test(u)) return;
      XHR_LOG.push({
        t: new Date().toISOString().slice(11, 19),
        status: r.status(),
        method: r.request().method(),
        url: u.slice(0, 300),
      });
      if (XHR_LOG.length > XHR_MAX) XHR_LOG = XHR_LOG.slice(-XHR_MAX);
    } catch (_) {}
  });
}

/* ================= 多账号：每个账号一个独立浏览器档案 ================= */

const ACCOUNTS_FILE = 'seller-accounts.json';

function accountsPath(ctx) {
  return path.join(ctx.baseDir, 'data', 'credentials', ACCOUNTS_FILE);
}
function slugOf(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'account'
  );
}
function readAccounts(ctx) {
  try {
    const j = JSON.parse(fs.readFileSync(accountsPath(ctx), 'utf8'));
    return { active: j.active || '', accounts: Array.isArray(j.accounts) ? j.accounts : [] };
  } catch (_) {
    return { active: '', accounts: [] };
  }
}
function writeAccounts(ctx, data) {
  const f = accountsPath(ctx);
  ensureDir(path.dirname(f));
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
}
/** 老版本只有一份凭据 + 一个档案目录，迁移成 default 账号，档案目录沿用原路径 */
function profileDirOf(ctx, acc) {
  if (acc.profileRoot) return path.join(ctx.baseDir, acc.profileRoot);
  return path.join(ctx.baseDir, 'data', 'profiles-seller', acc.id);
}

/** 登录态判断：档案目录里有 Cookies 之类的东西就算登录过 */
function hasSession(ctx, acc) {
  const p = profileDirOf(ctx, acc);
  try {
    return fs.existsSync(p) && fs.readdirSync(p).some((f) => /Cookies|Network|Local Storage/i.test(f));
  } catch (_) {
    return false;
  }
}

/** 给前端看的账号信息（密码永不外传，只说有没有存） */
function publicAccount(ctx, acc) {
  return {
    id: acc.id,
    label: acc.label || acc.account,
    account: acc.account,
    site: siteOf(acc), // 生效站点（没存过就按账号串猜出来的那个，前端据此显示并可一键切换）
    hasPassword: !!acc.p,
    hasSession: hasSession(ctx, acc),
    lastLoginAt: acc.lastLoginAt || '',
    createdAt: acc.createdAt || '',
  };
}

/** 记一次登录时间（重新读盘再改，避免写回被内存里的旧对象覆盖） */
function touchLogin(ctx, id) {
  try {
    const st = readAccounts(ctx);
    const a = st.accounts.find((x) => x.id === id);
    if (a) {
      a.lastLoginAt = new Date().toISOString();
      writeAccounts(ctx, st);
    }
  } catch (_) {}
}

/**
 * 打开卖家中心窗口：
 *  - **首次登录弹窗**（有头）—— 用户要求：登录就是「打开窗口登录」，别在应用里塞表单
 *  - 登录成功自动关窗；之后这个账号一律走无头（不再打扰用户）
 */
async function openSellerBrowser(ctx, SELLER_DIR, acc, url, visible) {
  /**
   * ⚠️ 用户反馈「卖家中心点登录没反应」的根因之一就在这个分支：
   *    自动导出会在后台留下一个**无头**常驻上下文；用户再来点「登录」时，
   *    老代码只是把那个看不见的窗口 goto 到登录页就返回了 ——
   *    既不弹窗、也不挂登录监听，用户当然觉得点了没用。
   *    要可见登录时，必须先把旧的（无头）上下文关掉，重新开一个真实窗口。
   */
  if (sellerCtx) {
    if (visible === true && sellerCtxHeadless !== false) {
      const old = sellerCtx;
      sellerCtx = null;
      sellerCtxHeadless = null;
      await old.close().catch(() => {});
    } else {
      const pg = sellerCtx.pages()[0];
      if (pg && url) await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      return { ok: true, alreadyOpen: true, headless: !!sellerCtxHeadless };
    }
  }
  const chromium = ctx.core.chromium;
  if (!chromium) throw new Error('核心没有提供 chromium（需要 patchright）');
  const profile = ensureDir(profileDirOf(ctx, acc));
  const exe = ctx.core.scraper.resolveChromePath();
  // 已存过登录态 → 无头；没存过 → 弹出来让人登
  const hl = visible === undefined ? hasSession(ctx, acc) : !visible;
  sellerCtx = await chromium.launchPersistentContext(profile, {
    headless: hl,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    args: ['--no-first-run', '--disable-dev-shm-usage'].concat(hl ? ['--window-position=-32000,-32000'] : []),
    ...(exe ? { executablePath: exe } : {}),
  });
  sellerCtxHeadless = !!hl;
  const attachDl = attachDownload(ctx, SELLER_DIR);
  sellerCtx.on('page', (p2) => {
    attachDl(p2);
    attachXhrLog(p2, ctx);
  });
  sellerCtx.pages().forEach((p2) => {
    attachDl(p2);
    attachXhrLog(p2, ctx);
  });
  const page = sellerCtx.pages()[0] || (await sellerCtx.newPage());
  attachDownload(ctx, SELLER_DIR)(page);
  attachXhrLog(page, ctx);
  await page.goto(url || DEFAULT_SELLER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  sellerCtx.on('close', () => {
    sellerCtx = null;
    sellerCtxHeadless = null;
  });

  // 有头登录模式：检测到登录成功（URL 离开 /account/login）就**自动关窗**，
  // 之后所有操作全走无头 —— 用户只在输密码那几十秒看到窗口。
  // ⚠️ 只在「开的是登录页」时才守着；开的是数据页就直接留着窗口给人操作。
  const openedLogin = /\/account\/login/i.test(url || '');
  if (!hl && openedLogin) {
    (async () => {
      for (let i = 0; i < 300; i++) {
        await new Promise((s2) => setTimeout(s2, 2000));
        if (!sellerCtx) return; // 用户自己关了
        try {
          const u = sellerCtx.pages()[0] ? sellerCtx.pages()[0].url() : '';
          if (u && !/account\/login/i.test(u)) {
            ctx.log('✅ 检测到登录成功，自动关闭登录窗口（之后全程无头，不再弹窗）');
            touchLogin(ctx, acc.id);
            const c = sellerCtx;
            sellerCtx = null;
            sellerCtxHeadless = null;
            await c.close().catch(() => {});
            return;
          }
        } catch (_) {
          return;
        }
      }
    })();
  }

  return {
    ok: true,
    headless: hl,
    first: !hl,
    note: hl
      ? '无头模式运行（登录态已保存）。导出文件会被自动接住入库。'
      : '请在打开的窗口里登录卖家中心（登录态会记住）。登录后回到视频分析页，把日期调好再点页面上的导出 —— 文件会被自动接住入库。',
  };
}

/** 统一的卖家浏览器启动（登录/套壳共用）。profileDir 决定用的是**哪个账号**的登录态 */
async function launchSeller(ctx, opts) {
  const headless = !!(opts && opts.headless);
  const chromium = ctx.core.chromium;
  if (!chromium) throw new Error('核心没有提供 chromium（需要 patchright）');
  const profile = ensureDir(
    (opts && opts.profileDir) || path.join(ctx.baseDir, 'data', 'profiles-seller')
  );
  const exe = ctx.core.scraper.resolveChromePath();
  return chromium.launchPersistentContext(profile, {
    headless: !!headless,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    args: ['--no-first-run', '--disable-dev-shm-usage'].concat(headless ? ['--window-position=-32000,-32000'] : []),
    ...(exe ? { executablePath: exe } : {}),
  });
}

/** ⚠️ 登录地址不再写死一个域名 —— 见上方 SELLER_SITES：泰国本地店与跨境全球店是两个站点，
 *  账号在哪个站点必须选对，否则密码对也登不进去。统一走 siteLoginUrl(acc)。 */

/**
 * 无头自动登录：应用里输入账号密码 → 装填 → 提交 → 轮询结果。
 * - 成功（URL 离开 /account/login）→ 关掉无头实例（profile 已带登录态），返回 ok
 * - 明确失败（密码错误等）→ 返回页面上的错误文案
 * - 其它（大概率是滑块验证码）→ 返回 needManual，调用方切回有头让人只处理验证
 */
async function autoLogin(ctx, acc, password, opts) {
  const account = acc.account;
  const isEmail = /@/.test(account);
  // ⚠️ 手动登录用**有头**窗口：滑块/邮箱验证在真实窗口里完成（用户要求「遇到滑块就弹出来」）。
  //    启动时的自动登录仍用无头，避免每次开机弹窗。
  const c = await launchSeller(ctx, { headless: !(opts && opts.visible), profileDir: profileDirOf(ctx, acc) });
  try {
    const page = c.pages()[0] || (await c.newPage());
    await page.goto(siteLoginUrlFromAccount(account), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
    if (isEmail) {
      // 默认是手机号 tab，账号含 @ 时先试着切到邮箱 tab（找不到就继续，有些版本同一输入框通吃）
      try {
        await page.click('text=/邮箱|Email/i', { timeout: 2000 });
        await page.waitForTimeout(800);
      } catch (_) {}
    }
    await page.fill('input[name=mobile]', account, { timeout: 8000 }).catch(() => {});
    await page.fill('input[name=password]', password, { timeout: 8000 }).catch(() => {});
    await page.click('button[name=loginBtn]', { timeout: 5000 }).catch(() => page.keyboard.press('Enter'));

    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(1000);
      const u = page.url();
      if (u && !/account\/login/i.test(u)) {
        try { await c.close(); } catch (_) {} // 登录成功立刻关窗（用户要求）
        return { ok: true };
      }
      const err = await page
        .evaluate(() => {
          const pat = /(密码错误|账号不存在|用户不存在|登录失败|请输入)/;
          const cap = /(滑动|滑块|验证码|captcha|security check)/i;
          let out = '';
          document.querySelectorAll('div,span,p').forEach((e) => {
            const t = (e.textContent || '').trim();
            if (!t || t.length > 60) return;
            if (!out && pat.test(t) && e.children.length === 0) out = t;
            if (!out && cap.test(t) && e.children.length === 0) out = 'CAPTCHA: ' + t;
          });
          return out;
        })
        .catch(() => '');
      if (/^(密码错误|账号不存在|用户不存在|登录失败)/.test(err)) return { fail: err };
      if (/CAPTCHA/.test(err)) {
        // 出验证码：有视觉模型就先让 AI 试滑块（最多 3 次），失败才降级为开窗人工
        const sol = await captcha.solveWithRetry(page, ctx, 3).catch((e) => ({ solved: false, reason: e.message }));
        if (sol.solved) {
          for (let k = 0; k < 8; k++) {
            await page.waitForTimeout(1000);
            if (!/account\/login/i.test(page.url())) return { ok: true, viaCaptcha: true };
          }
        }
        return { manual: '滑块验证：' + (sol.reason || '未通过') };
      }
      if (i >= 14) return { manual: err.replace(/^CAPTCHA:\s*/, '') || '需要人工处理验证' };
    }
    return { manual: '登录超时' };
  } finally {
    // 无头模式：结果出来就关（profile 已存状态）
    // 有头模式：**不关**，留给用户处理滑块/验证；成功检测到后由 needManual 分支或用户手动关
    if (!(opts && opts.visible)) await c.close().catch(() => {});
  }
}

module.exports = {
  register(app, ctx) {
    const { core, config, log } = ctx;
    const SELLER_DIR = path.join(ctx.baseDir, 'data', 'seller');
    ensureDir(SELLER_DIR);

    const listFiles = () =>
      fs
        .readdirSync(SELLER_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(SELLER_DIR, f), 'utf8'));
            return { file: f, dateRange: j.dateRange || '', rows: (j.rows || []).length, importedAt: j.importedAt };
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean);

    /** 上传（body = xlsx 原始字节） */
    app.post('/api/seller-import/upload', async (req, res) => {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const buf = Buffer.concat(chunks);
        if (!buf.length) return res.status(400).json({ error: '没有收到文件内容' });

        const parsed = await parseWorkbook(ctx, buf);
        if (!parsed.rows.length) return res.status(400).json({ error: '解析到 0 行数据，请确认文件内容' });

        const name = `${Date.now()}-${parsed.rows.length}.json`;
        const record = {
          importedAt: new Date().toISOString(),
          dateRange: parsed.dateRange,
          rows: parsed.rows,
        };
        fs.writeFileSync(path.join(SELLER_DIR, name), JSON.stringify(record));
        log(`导入卖家中心数据 ${parsed.rows.length} 条（${parsed.dateRange}）`);
        res.json({ ok: true, file: name, dateRange: parsed.dateRange, count: parsed.rows.length, all: listFiles() });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    app.get('/api/seller-import/files', (req, res) => res.json({ files: listFiles() }));

    /** 无头校验某个账号的登录态：打开视频分析页，看会不会被踢回登录页 */
    async function verifySession(ctx, acc) {
      let c = null;
      try {
        c = await launchSeller(ctx, { headless: true, profileDir: profileDirOf(ctx, acc) });
        const page = c.pages()[0] || (await c.newPage());
        await page
          .goto(siteHomeUrl(acc), { waitUntil: 'domcontentloaded', timeout: 45000 })
          .catch(() => {});
        await page.waitForTimeout(3000);
        return !/\/account\/login/i.test(page.url() || '');
      } catch (_) {
        return false;
      } finally {
        if (c) await c.close().catch(() => {});
      }
    }

    /**
     * 登录状态：对「当前账号」无头验一次。
     * ?id=xxx 可以指定账号；带 verify=0 时只看档案里有没有登录态，不真的开浏览器（快）。
     */
    app.get('/api/seller-import/status', async (req, res) => {
      try {
        const st = readAccounts(ctx);
        const acc = pickAccount(st, (req.query && req.query.id) || st.active);
        if (!acc) {
          return res.json({ platform: 'seller-center', loggedIn: false, ...listAccounts(), note: '还没有添加账号' });
        }
        const quick = req.query && String(req.query.verify) === '0';
        const loggedIn = quick ? hasSession(ctx, acc) : await verifySession(ctx, acc);
        res.json({
          platform: 'seller-center',
          loggedIn,
          id: acc.id,
          account: acc.account,
          ...listAccounts(),
        });
      } catch (e) {
        res.json({ platform: 'seller-center', loggedIn: false, error: e.message, ...listAccounts() });
      }
    });

    app.delete('/api/seller-import/files/:name', (req, res) => {
      const f = path.basename(req.params.name);
      const p = path.join(SELLER_DIR, f);
      if (fs.existsSync(p)) fs.rmSync(p);
      res.json({ ok: true, all: listFiles() });
    });

    /**
     * 交叉分析：把某次抓取任务（TikTok 为主）与导入的卖家中心数据按 视频ID 对齐。
     * 返回三份名单 + 对比指标，并顺带校验 item_list 的 isECVideo 是否与卖家中心一致。
     */
    app.post('/api/seller-import/analyze', async (req, res) => {
      const jobId = req.body && req.body.jobId;
      const file = req.body && req.body.file;
      if (!jobId) return res.status(400).json({ error: '缺少 jobId' });

      const jobPath = path.join(ctx.dataDir, `${jobId}.json`);
      if (!fs.existsSync(jobPath)) return res.status(404).json({ error: `找不到任务 ${jobId}` });
      const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
      // ⚠️ 任务落盘存的是 results（原始 item 数组），扁平行要用核心的 toRows 现场算
      const tiktokRows = core.report.toRows(job.results || []);

      // 选卖家中心数据：指定文件，否则用最新一份
      const files = listFiles();
      if (!files.length) return res.status(400).json({ error: '还没导入过卖家中心数据' });
      const chosen = file ? files.find((f) => f.file === file) : files[files.length - 1];
      if (!chosen) return res.status(404).json({ error: `找不到卖家中心文件 ${file}` });
      const rec = JSON.parse(fs.readFileSync(path.join(SELLER_DIR, chosen.file), 'utf8'));
      const sellerMap = new Map((rec.rows || []).map((r) => [r.vid, r]));

      // 对齐
      const carted = []; // 挂车（TikTok ∩ 卖家中心）
      const nonCarted = []; // 没挂车（TikTok 有，卖家中心没有）
      const sellerOnly = []; // 卖家中心独有 → 广告/混剪，剔除
      let flagAgree = 0;
      let flagDisagree = 0;
      const disagreements = [];

      for (const r of tiktokRows) {
        const vid = String(r.vid || '').trim();
        const s = sellerMap.get(vid);
        if (s) {
          carted.push({ ...r, seller: s, isEC: true });
          if (r.isEC === true) flagAgree++;
          else { flagDisagree++; disagreements.push({ vid, tiktokFlag: !!r.isEC }); }
        } else {
          nonCarted.push({ ...r, isEC: false });
          if (r.isEC === false) flagAgree++;
          else { flagDisagree++; disagreements.push({ vid, tiktokFlag: !!r.isEC }); }
        }
      }
      const tiktokVids = new Set(tiktokRows.map((r) => String(r.vid || '').trim()));
      for (const s of rec.rows || []) {
        if (!tiktokVids.has(s.vid)) sellerOnly.push(s);
      }

      // 日期范围内对比（TikTok 行自带 date）
      const from = req.body.from;
      const to = req.body.to;
      const inRange = (r) => (!from || r.date >= from) && (!to || r.date <= to);
      const cRows = carted.filter(inRange);
      const nRows = nonCarted.filter(inRange);

      // 指标：沿用核心 agg，再叠商家指标
      const sum = (rows, k) => rows.reduce((t, r) => t + (Number((r.seller || r)[k]) || 0), 0);
      const aggOf = (rows) => {
        const a = core.report.agg(rows);
        return {
          ...a,
          gmv: sum(rows, 'gmv'),
          orders: sum(rows, 'videoOrders'),
          productClicks: sum(rows, 'productClicks'),
          gpm: rows.length ? Number((sum(rows, 'gmv') / (rows.reduce((t, r) => t + (Number(r.views) || 0), 0) / 1000)).toFixed(2)) : 0,
        };
      };
      const ec = aggOf(cRows);
      const non = aggOf(nRows);
      const metrics = ['n', 'tv', 'avg', 'med', 'max', 'avgLikes', 'avgComments', 'avgShares', 'avgSaves', 'avgReposts', 'avgDuration', 'inter', 'gmv', 'orders', 'productClicks', 'gpm'];

      res.json({
        ok: true,
        file: chosen.file,
        dateRange: rec.dateRange || '',
        counts: {
          tiktok: tiktokRows.length,
          carted: carted.length,
          nonCarted: nonCarted.length,
          sellerOnly: sellerOnly.length,
          sellerOnlyNote: '卖家中心有、TikTok 没有 → 广告计划/混剪，已按规则剔除',
        },
        flagCheck: { agree: flagAgree, disagree: flagDisagree, disagreements: disagreements.slice(0, 20) },
        compare: { metrics, ec, non },
        carted: carted.map((r) => ({ ...r, seller: undefined, ...r.seller })),
        sellerOnly: sellerOnly.slice(0, 200),
        dateRangeApplied: { from: from || '', to: to || '' },
      });
    });

    /* ==================== 多账号管理 ==================== */
    // ⚠️ 卖家中心与 TikTok 账号不是一回事，凭据分文件存，混用会登录到错误站点
    const CRED_FILE = path.join(ctx.baseDir, 'data', 'credentials', 'seller-center.json');

    /** 旧版单凭据（data/credentials.json → seller-center.json）读出来只用于迁移 */
    const readLegacyCreds = () => {
      try {
        const j = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
        return { account: j.account || '', password: Buffer.from(j.p || '', 'base64').toString('utf8') };
      } catch (_) {
        return { account: '', password: '' };
      }
    };

    const newId = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const pickAccount = (st, id) =>
      st.accounts.find((a) => a.id === id) ||
      st.accounts.find((a) => a.id === st.active) ||
      st.accounts[0] ||
      null;
    const listAccounts = () => {
      const st = readAccounts(ctx);
      return {
        active: st.active || (st.accounts[0] && st.accounts[0].id) || '',
        accounts: st.accounts.map((a) => publicAccount(ctx, a)),
      };
    };
    const decodePw = (acc) => Buffer.from(acc.p || '', 'base64').toString('utf8');

    /** 迁移：老版只有一份凭据 + 一个档案目录 → 变成 default 账号，档案沿用老目录（登录态不丢） */
    function migrateLegacyCreds() {
      const oldGeneric = path.join(ctx.baseDir, 'data', 'credentials.json');
      try {
        if (fs.existsSync(oldGeneric) && !fs.existsSync(CRED_FILE)) {
          const j = JSON.parse(fs.readFileSync(oldGeneric, 'utf8'));
          if (j && j.account) {
            fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
            fs.writeFileSync(CRED_FILE, JSON.stringify(j));
            log('已把旧凭据迁移到 data/credentials/seller-center.json');
          }
        }
      } catch (_) {}

      const st = readAccounts(ctx);
      const c = readLegacyCreds();
      if (!c.account || st.accounts.length) return st;
      const acc = {
        id: 'default',
        label: c.account,
        account: c.account,
        p: Buffer.from(c.password, 'utf8').toString('base64'),
        profileRoot: 'data' + path.sep + 'profiles-seller', // 沿用老目录
        createdAt: new Date().toISOString(),
        lastLoginAt: '',
      };
      st.accounts.push(acc);
      st.active = acc.id;
      writeAccounts(ctx, st);
      log(`已把旧单凭据迁移为账号「${acc.account}」（沿用原档案目录，登录态不丢）`);
      return st;
    }

    /** 列表 */
    app.get('/api/seller-import/accounts', (req, res) => res.json(listAccounts()));

    /** 新增账号（密码可留空 → 只开窗扫码/手动登） */
    app.post('/api/seller-import/accounts', (req, res) => {
      const account = String((req.body && req.body.account) || '').trim();
      const password = String((req.body && req.body.password) || '');
      const label = String((req.body && req.body.label) || '').trim() || account;
      if (!account) return res.status(400).json({ error: '请填写账号' });
      const st = readAccounts(ctx);
      if (st.accounts.some((a) => a.account === account)) {
        return res.status(400).json({ error: `账号 ${account} 已经添加过了` });
      }
      const siteRaw = String((req.body && req.body.site) || '').trim();
      const acc = {
        id: slugOf(account) + '-' + newId().slice(1),
        label,
        account,
        site: SELLER_SITES[siteRaw] ? siteRaw : guessSite(account),
        p: password ? Buffer.from(password, 'utf8').toString('base64') : '',
        createdAt: new Date().toISOString(),
        lastLoginAt: '',
      };
      st.accounts.push(acc);
      if (!st.active) st.active = acc.id;
      writeAccounts(ctx, st);
      log(`已添加卖家中心账号「${account}」`);
      res.json({ ok: true, id: acc.id, ...listAccounts() });
    });

    /** 改资料（label / account / password 都可选） */
    app.patch('/api/seller-import/accounts/:id', (req, res) => {
      const st = readAccounts(ctx);
      const acc = st.accounts.find((a) => a.id === req.params.id);
      if (!acc) return res.status(404).json({ error: '账号不存在' });
      if (req.body && req.body.label !== undefined) acc.label = String(req.body.label).trim() || acc.account;
      if (req.body && req.body.account !== undefined) acc.account = String(req.body.account).trim();
      if (req.body && req.body.password !== undefined) {
        acc.p = req.body.password ? Buffer.from(String(req.body.password), 'utf8').toString('base64') : '';
      }
      if (req.body && req.body.site !== undefined && SELLER_SITES[String(req.body.site)]) {
        acc.site = String(req.body.site);
      }
      writeAccounts(ctx, st);
      res.json({ ok: true, ...listAccounts() });
    });

    /**
     * 诊断：这个账号会被登录到哪个域名。
     * 「卖家中心登不上」最常见的原因就是站点选错（泰国本地店 vs 跨境全球店），
     * 所以把实际解析出来的地址直接暴露出来，排查时不用猜。
     */
    app.get('/api/seller-import/accounts/:id/target', (req, res) => {
      const st = readAccounts(ctx);
      const acc = pickAccount(st, req.params.id);
      if (!acc) return res.status(404).json({ error: '账号不存在' });
      res.json({
        id: acc.id,
        account: acc.account,
        site: siteOf(acc),
        guessed: !(acc.site && SELLER_SITES[acc.site]),
        login: siteLoginUrl(acc),
        home: siteHomeUrl(acc),
        sites: Object.keys(SELLER_SITES),
      });
    });

    /** 切换当前账号 */
    app.post('/api/seller-import/accounts/:id/active', (req, res) => {
      const st = readAccounts(ctx);
      if (!st.accounts.some((a) => a.id === req.params.id)) return res.status(404).json({ error: '账号不存在' });
      st.active = req.params.id;
      writeAccounts(ctx, st);
      res.json({ ok: true, ...listAccounts() });
    });

    /** 删除账号。?purge=1 才连登录档案一起删（默认保留，之后加回来登录态还在） */
    app.delete('/api/seller-import/accounts/:id', (req, res) => {
      const st = readAccounts(ctx);
      const acc = st.accounts.find((a) => a.id === req.params.id);
      if (!acc) return res.status(404).json({ error: '账号不存在' });
      st.accounts = st.accounts.filter((a) => a.id !== req.params.id);
      if (st.active === req.params.id) st.active = (st.accounts[0] && st.accounts[0].id) || '';
      writeAccounts(ctx, st);
      if (String(req.query.purge) === '1') {
        fs.rmSync(profileDirOf(ctx, acc), { recursive: true, force: true });
        log(`已删除账号「${acc.account}」及其登录档案`);
      } else {
        log(`已删除账号「${acc.account}」（登录档案保留）`);
      }
      res.json({ ok: true, purged: String(req.query.purge) === '1', ...listAccounts() });
    });

    /** 退出登录 = 清掉这个账号的浏览器档案，下次点登录会重新弹窗 */
    app.post('/api/seller-import/accounts/:id/logout', async (req, res) => {
      const st = readAccounts(ctx);
      const acc = st.accounts.find((a) => a.id === req.params.id);
      if (!acc) return res.status(404).json({ error: '账号不存在' });
      if (sellerCtx) {
        const c = sellerCtx;
        sellerCtx = null;
        await c.close().catch(() => {});
      }
      fs.rmSync(profileDirOf(ctx, acc), { recursive: true, force: true });
      log(`账号「${acc.account}」已退出登录`);
      res.json({ ok: true, ...listAccounts() });
    });

    /**
     * 登录 = 打开窗口登录（用户要求）。
     *  - 没有登录态（首次）→ 有头弹窗，登录成功自动关窗
     *  - 已登录过         → 先无头校验；有效就直接过（不弹窗），失效才重开窗口
     */
    const handleLogin = async (req, res) => {
      try {
        let st = readAccounts(ctx);
        // 老前端只传 {account,password}：按账号名找到或新建，再走同一套登录流程
        let acc = req.params && req.params.id ? st.accounts.find((a) => a.id === req.params.id) : null;
        if (!acc) {
          const account = String((req.body && req.body.account) || '').trim();
          acc = account ? st.accounts.find((a) => a.account === account) : null;
          if (!acc) {
            if (!account) return res.status(400).json({ error: '请指定账号' });
            acc = {
              id: slugOf(account) + '-' + newId().slice(1),
              label: account,
              account,
              p: '',
              createdAt: new Date().toISOString(),
              lastLoginAt: '',
            };
            st.accounts.push(acc);
          }
          const pw = String((req.body && req.body.password) || '');
          if (pw) acc.p = Buffer.from(pw, 'utf8').toString('base64');
          st = { active: acc.id, accounts: st.accounts };
          writeAccounts(ctx, st);
        }
        if (!st.accounts.includes(acc)) return res.status(404).json({ error: '账号不存在' });
        if (st.active !== acc.id) {
          st.active = acc.id;
          writeAccounts(ctx, st);
        }
        if (sellerCtx) {
          const c = sellerCtx;
          sellerCtx = null;
          await c.close().catch(() => {});
        }

        const hadSession = hasSession(ctx, acc);
        const forceVisible = !!(req.body && req.body.visible);

        // 已登录过 → 无头校验一次，还有效就不打扰用户
        if (hadSession && !forceVisible) {
          if (await verifySession(ctx, acc)) {
            return res.json({
              ok: true,
              visible: false,
              first: false,
              note: '登录态有效，已在无头模式下连接（没有弹窗）。',
              ...listAccounts(),
            });
          }
          // 失效了：有密码先无头重登一次
          const pw = decodePw(acc);
          if (pw) {
            const r = await autoLogin(ctx, acc, pw);
            if (r.ok) {
              touchLogin(ctx, acc.id);
              return res.json({
                ok: true,
                visible: false,
                first: false,
                note: '登录态过期，已用保存的密码自动重登（无头）。',
                ...listAccounts(),
              });
            }
          }
        }

        // 首次 / 需要人工 → 弹窗（登录成功由 watcher 记时间）
        const v = await openSellerBrowser(ctx, SELLER_DIR, acc, siteLoginUrl(acc), true);
        return res.json({ ...v, visible: true, first: !hadSession, ...listAccounts() });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    };
    app.post('/api/seller-import/accounts/:id/login', handleLogin);
    app.post('/api/seller-import/login', handleLogin); // 兼容老前端（传 account/password）

    // 启动不弹窗：只对「存了密码但还没有登录态」的账号做一次无头尝试
    (async () => {
      const st = migrateLegacyCreds();
      for (const acc of st.accounts) {
        if (!acc.p || hasSession(ctx, acc)) continue;
        try {
          const r = await autoLogin(ctx, acc, decodePw(acc));
          if (r.ok) log(`✅ 卖家中心账号「${acc.account}」自动登录成功（无头）`);
          else log(`卖家中心账号「${acc.account}」暂未自动登录：${r.fail || r.manual || ''}（点「登录」会开窗让你处理）`);
        } catch (e) {
          log(`卖家中心账号「${acc.account}」自动登录出错：${e.message}`);
        }
      }
    })();

    /* 套壳：打开卖家中心窗口（导出文件自动接住入库） */
    app.post('/api/seller-import/open-browser', async (req, res) => {
      try {
        const st = readAccounts(ctx);
        const acc = pickAccount(st, (req.body && req.body.id) || st.active);
        if (!acc) return res.status(400).json({ error: '请先添加一个卖家中心账号' });
        const url = (req.body && req.body.url) || siteHomeUrl(acc);
        const visible = req.body && req.body.visible !== undefined ? !!req.body.visible : undefined;
        const r = await openSellerBrowser(ctx, SELLER_DIR, acc, url, visible);
        res.json(r);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    /* 诊断：列出页面发出的 API 请求（用于分析卖家中心的数据接口，做全自动导出用） */
    app.get('/api/seller-import/xhr-log', (req, res) => {
      res.json({ open: !!sellerCtx, count: XHR_LOG.length, log: XHR_LOG });
    });

    app.post('/api/seller-import/close-browser', (req, res) => {
      if (!sellerCtx) return res.json({ ok: true, wasOpen: false });
      const c = sellerCtx;
      sellerCtx = null;
      sellerCtxHeadless = null;
      c.close().catch(() => {});
      res.json({ ok: true, wasOpen: true });
    });

    app.get('/api/seller-import/browser-status', (req, res) => {
      res.json({ open: !!sellerCtx, pages: sellerCtx ? sellerCtx.pages().length : 0 });
    });

    /* ==================== 自动导入（Round 6） ==================== */
    /**
     * 自动导入 = 打开卖家中心窗口（有登录态就无头）→ 自动点「导出」→ 下载被接住自动入库。
     * 页面上导出按钮的结构会变，所以点击是 best-effort：点不动就把窗口留着让人手动点，
     * 下载监听始终挂着，手动导出一样会被自动接住。
     */
    async function tryClickExport(page, log2) {
      try {
        const btn = page
          .locator('button:has-text("导出"), [role=button]:has-text("导出"), button:has-text("Export"), [role=button]:has-text("Export")')
          .first();
        await btn.click({ timeout: 5000 });
        await page.waitForTimeout(1500);
        // 有些版本会先弹确认框
        for (const ok of ['确定', '确认', '导出', 'OK', 'Confirm', 'Export']) {
          try {
            await page.locator(`button:has-text("${ok}")`).first().click({ timeout: 1500 });
            break;
          } catch (_) {}
        }
        log2('已自动点击导出，等待文件…');
        return true;
      } catch (_) {
        return false;
      }
    }

    app.post('/api/seller-import/auto-export', async (req, res) => {
      try {
        const st = readAccounts(ctx);
        const acc = pickAccount(st, (req.body && req.body.id) || st.active);
        if (!acc) return res.status(400).json({ error: '请先添加一个卖家中心账号（设置 → 登录）' });
        if (!hasSession(ctx, acc)) {
          return res.status(400).json({ error: '该账号还没有登录态，请先在设置里登录卖家中心' });
        }
        const r = await openSellerBrowser(ctx, SELLER_DIR, acc, siteHomeUrl(acc), undefined);
        // 后台等页面加载后尝试自动点导出；失败不报错（窗口留着手动点）
        (async () => {
          try {
            const pg = sellerCtx && sellerCtx.pages()[0];
            if (!pg) return;
            await pg.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
            await pg.waitForTimeout(3000);
            const clicked = await tryClickExport(pg, log);
            if (!clicked) log('没找到导出按钮，窗口已打开 —— 请手动点导出，文件照样会被自动接住');
          } catch (e) {
            log(`自动导出尝试失败：${e.message}（可手动在窗口里导出）`);
          }
        })();
        res.json({ ok: true, headless: r.headless, note: r.headless ? '已在后台打开卖家中心并尝试自动导出，文件会自动接住入库。' : '卖家中心窗口已打开，正在尝试自动导出；若未触发请手动点导出，文件会自动接住入库。' });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    /* 登录成功后自动导入 + 抓取（用户要求：登录了就该自动拿数据，失败要能重试）。
       走的是与主页「手动导入」完全相同的入库管线，所以落库结构一致。 */
    app.post('/api/seller-import/login-sync', async (req, res) => {
      try {
        const st = readAccounts(ctx);
        const acc = pickAccount(st, (req.body && req.body.id) || st.active);
        if (!acc) return res.status(400).json({ error: '请先添加一个卖家中心账号（设置 → 卖家中心登录）' });
        if (!hasSession(ctx, acc)) return res.status(400).json({ error: '该账号还没有登录态，请先登录' });
        const before = listFiles().length;
        const r = await openSellerBrowser(ctx, SELLER_DIR, acc, siteHomeUrl(acc), undefined);
        let clicked = false;
        if (r.headless) {
          // 无头：后台等页面就绪后自动点导出，文件会被 watch 住并自动入库
          const pg = sellerCtx && sellerCtx.pages()[0];
          if (pg) {
            await pg.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
            await pg.waitForTimeout(3000);
            clicked = await tryClickExport(pg, log).catch(() => false);
          }
        }
        // 等待文件落库（有新增文件即视为成功）
        const ok = await (async () => {
          for (let i = 0; i < 40; i++) {
            if (listFiles().length > before) return true;
            await new Promise((r3) => setTimeout(r3, 500));
          }
          return false;
        })();
        res.json({
          ok,
          headless: !!r.headless,
          clicked,
          files: listFiles().length,
          error: ok ? '' : '已打开卖家中心但没有接住导出文件 —— 请在弹出的窗口里点一次「导出」，或用主页的「手动导入」上传 xlsx',
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    /* ==================== 数据同步提供者（Round 6） ====================
       抓取完成后，核心会把这里返回的商家指标自动合并进视频列表行 ——
       无需手动导入动作；重合字段（播放/点赞…）由核心剔除，以 TikTok 抓取为准。 */
    if (typeof ctx.registerSync === 'function') {
      ctx.registerSync({
        platform: 'seller',
        collect: async () => {
          const files = listFiles();
          if (!files.length) return {};
          const map = {};
          for (const f of files) {
            try {
              const rec = JSON.parse(fs.readFileSync(path.join(SELLER_DIR, f.file), 'utf8'));
              for (const r2 of rec.rows || []) {
                if (!r2.vid) continue;
                // 只放平台独有字段（重合的核心会剔除，这里干脆不放）
                map[String(r2.vid)] = {
                  gmv: r2.gmv,
                  attributedGmv: r2.attributedGmv,
                  orders: r2.videoOrders,
                  productClicks: r2.productClicks,
                  productImpressions: r2.productImpressions,
                  gpm: r2.gpm,
                  ctr: r2.ctr,
                  ctor: r2.ctor,
                  completionRate: r2.completionRate,
                  leads: r2.leads,
                  newFans: r2.newFans,
                  product: r2.product,
                };
              }
            } catch (_) {}
          }
          return map;
        },
      });
    }

    log('卖家中心数据已挂载：/api/seller-import/*（含自动导入与数据同步）');
  },
};

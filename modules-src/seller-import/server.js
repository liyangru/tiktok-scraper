/**
 * 模块：卖家中心导入与挂车分析
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
const captcha = require('./captcha.js');
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

const DEFAULT_SELLER_URL =
  'https://seller.tiktokshopglobalselling.com/compass/video-analytics/video-details?platform_data_source=shop&shop_region=TH';

let sellerCtx = null;

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

/** 登录态判断：profile 目录里有内容就当作已登录过（够用，不做复杂探测） */
function hasSavedLogin(ctx) {
  const p = path.join(ctx.baseDir, 'data', 'profiles-seller');
  try {
    return fs.existsSync(p) && fs.readdirSync(p).some((f) => /Cookies|Network|Local Storage/i.test(f));
  } catch (_) {
    return false;
  }
}

/** 打开卖家中心：headless=true 无头（登录之后都用这个）；false 有头（第一次人工登录） */
async function openSellerBrowser(ctx, SELLER_DIR, url, headless) {
  if (sellerCtx) {
    const pg = sellerCtx.pages()[0];
    if (pg && url) await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    return { ok: true, alreadyOpen: true };
  }
  const chromium = ctx.core.chromium;
  if (!chromium) throw new Error('核心没有提供 chromium（需要 patchright）');
  const profile = ensureDir(path.join(ctx.baseDir, 'data', 'profiles-seller'));
  const exe = ctx.core.scraper.resolveChromePath();
  const hl = headless === undefined ? hasSavedLogin(ctx) : !!headless; // 已登录过 → 默认无头
  sellerCtx = await chromium.launchPersistentContext(profile, {
    headless: hl,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    args: ['--no-first-run', '--disable-dev-shm-usage'].concat(hl ? ['--window-position=-32000,-32000'] : []),
    ...(exe ? { executablePath: exe } : {}),
  });
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
  });

  // 有头登录模式：检测到登录成功（URL 离开 /account/login）就**自动关窗**，
  // 之后所有操作全走无头 —— 用户只在输密码那几十秒看到窗口。
  if (!hl) {
    (async () => {
      for (let i = 0; i < 300; i++) {
        await new Promise((s2) => setTimeout(s2, 2000));
        if (!sellerCtx) return; // 用户自己关了
        try {
          const u = sellerCtx.pages()[0] ? sellerCtx.pages()[0].url() : '';
          if (u && !/account\/login/i.test(u)) {
            ctx.log('✅ 检测到登录成功，自动关闭登录窗口（之后全程无头，不再弹窗）');
            const c = sellerCtx;
            sellerCtx = null;
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

/** 统一的卖家浏览器启动（登录/套壳共用） */
async function launchSeller(ctx, headless) {
  const chromium = ctx.core.chromium;
  if (!chromium) throw new Error('核心没有提供 chromium（需要 patchright）');
  const profile = ensureDir(path.join(ctx.baseDir, 'data', 'profiles-seller'));
  const exe = ctx.core.scraper.resolveChromePath();
  return chromium.launchPersistentContext(profile, {
    headless: !!headless,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    args: ['--no-first-run', '--disable-dev-shm-usage'].concat(headless ? ['--window-position=-32000,-32000'] : []),
    ...(exe ? { executablePath: exe } : {}),
  });
}

const LOGIN_URL =
  'https://seller.tiktokshopglobalselling.com/account/login?platform_data_source=shop&shop_region=TH';

/**
 * 无头自动登录：应用里输入账号密码 → 装填 → 提交 → 轮询结果。
 * - 成功（URL 离开 /account/login）→ 关掉无头实例（profile 已带登录态），返回 ok
 * - 明确失败（密码错误等）→ 返回页面上的错误文案
 * - 其它（大概率是滑块验证码）→ 返回 needManual，调用方切回有头让人只处理验证
 */
async function autoLogin(ctx, account, password, opts) {
  const isEmail = /@/.test(account);
  // ⚠️ 手动登录用**有头**窗口：滑块/邮箱验证在真实窗口里完成（用户要求「遇到滑块就弹出来」）。
  //    启动时的自动登录仍用无头，避免每次开机弹窗。
  const c = await launchSeller(ctx, !(opts && opts.visible));
  try {
    const page = c.pages()[0] || (await c.newPage());
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
      if (u && !/account\/login/i.test(u)) return { ok: true };
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

    const SELLER_DIR_REF = SELLER_DIR;
    // ⚠️ 平台凭据必须分开存：卖家中心与 TikTok 账号不是一回事，混用会导致登录到错误站点
    const CRED_FILE = path.join(ctx.baseDir, 'data', 'credentials', 'seller-center.json');

    /** 凭据存本地（base64 遮一层，仅防误读；不进 git、不上云） */
    const readCreds = () => {
      try {
        const j = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
        return { account: j.account || '', password: Buffer.from(j.p || '', 'base64').toString('utf8') };
      } catch (_) { return { account: '', password: '' }; }
    };
    const writeCreds = (account, password) => {
      fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
      fs.writeFileSync(CRED_FILE, JSON.stringify({ account, p: Buffer.from(password, 'utf8').toString('base64') }));
    };

    // 一次性迁移：旧版把凭据放在 data/credentials.json（与其它平台混用），搬到独立文件
    (() => {
      const old = path.join(ctx.baseDir, 'data', 'credentials.json');
      try {
        if (fs.existsSync(old) && !fs.existsSync(CRED_FILE)) {
          const j = JSON.parse(fs.readFileSync(old, 'utf8'));
          if (j && j.account) {
            fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
            fs.writeFileSync(CRED_FILE, JSON.stringify(j));
            log('已把旧凭据迁移到 data/credentials/seller-center.json');
          }
        }
      } catch (_) {}
    })();

    app.get('/api/seller-import/credentials', (req, res) => {
      const c = readCreds();
      res.json({ platform: 'seller-center', account: c.account, password: c.password, has: !!(c.account && c.password) });
    });
    app.post('/api/seller-import/credentials', (req, res) => {
      const a = String((req.body && req.body.account) || '').trim();
      const p2 = String((req.body && req.body.password) || '');
      if (!a || !p2) return res.status(400).json({ error: '账号密码都要有' });
      writeCreds(a, p2);
      res.json({ ok: true, note: '已保存到本机 data/credentials/seller-center.json（不上云）' });
    });

    // 启动时若存了凭据 → 后台自动无头登录一次（免二次输入）
    (async () => {
      const c = readCreds();
      if (c.account && c.password) {
        try {
          const r = await autoLogin(ctx, c.account, c.password);
          log(r.ok ? '✅ 已用保存的凭据自动登录卖家中心（无头）' : `自动登录未完成：${r.fail || r.manual || ''}`);
        } catch (e) { log(`自动登录失败：${e.message}`); }
      }
    })();

    /* 套壳：打开卖家中心窗口（第一次要人工登录；导出文件自动接住入库） */
    app.post('/api/seller-import/open-browser', async (req, res) => {
      try {
        const url = (req.body && req.body.url) || DEFAULT_SELLER_URL;
        const r = await openSellerBrowser(ctx, SELLER_DIR_REF, url, req.body ? req.body.headless : undefined);
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
      c.close().catch(() => {});
      res.json({ ok: true, wasOpen: true });
    });

    app.get('/api/seller-import/browser-status', (req, res) => {
      res.json({ open: !!sellerCtx, pages: sellerCtx ? sellerCtx.pages().length : 0 });
    });

    /* 应用内登录：账号密码 → 无头装填提交；出验证码时自动切有头让人只处理验证 */
    app.post('/api/seller-import/login', async (req, res) => {
      const account = String((req.body && req.body.account) || '').trim();
      const password = String((req.body && req.body.password) || '');
      if (!account || !password) return res.status(400).json({ error: '请输入账号和密码' });
      try {
        if (sellerCtx) {
          const c = sellerCtx;
          sellerCtx = null;
          await c.close().catch(() => {});
        }
        if (req.body && req.body.remember) writeCreds(account, password);
        const r = await autoLogin(ctx, account, password, { visible: true });
        if (r.ok) return res.json({ ok: true, loggedIn: true, note: '登录成功（全程无头，没有弹窗）。登录态已保存。' });
        if (r.fail) return res.status(400).json({ error: r.fail });
        // 需要人工（大概率滑块验证）→ 切回有头，复用同一 profile 让用户只处理验证
        const v = await openSellerBrowser(ctx, SELLER_DIR_REF, LOGIN_URL, false);
        return res.json({
          needManual: true,
          reason: r.manual,
          note: v.note,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    log('卖家中心导入模块已挂载：/api/seller-import/*');
  },
};

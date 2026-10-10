/**
 * 模块：TikTok 账号登录（套壳创作者中心的前置）
 *
 * 两种登录，全程无头（不弹窗）：
 *   1. 扫码（优先）：无头拿到登录页二维码 → 截图回传应用界面 → 用户手机扫码 → 轮询成功
 *   2. 账密/邮箱：装填提交（出验证码同卖家中心处理）
 *
 * 登录态存独立 profile（data/profiles-tiktok），之后抓创作者中心数据（平均观看时长/完播率/
 * 流量来源/受众画像）、完整评论区、关注粉丝列表都靠它。
 */
const path = require('path');

const LOGIN_QR = 'https://www.tiktok.com/login/qrcode';
const LOGIN_PWD = 'https://www.tiktok.com/login/phone-or-email/email';

let tctx = null;

async function launch(ctx, headless = true) {
  if (tctx) return tctx;
  const chromium = ctx.core.chromium;
  if (!chromium) throw new Error('核心没有提供 chromium');
  const profile = path.join(ctx.baseDir, 'data', 'profiles-tiktok');
  require('fs').mkdirSync(profile, { recursive: true });
  const exe = ctx.core.scraper.resolveChromePath();
  tctx = await chromium.launchPersistentContext(profile, {
    headless: !!headless,
    viewport: { width: 1280, height: 860 },
    args: ['--no-first-run', '--disable-dev-shm-usage'].concat(headless ? [] : ['--window-position=-32000,-32000']),
    ...(exe ? { executablePath: exe } : {}),
  });
  tctx.on('close', () => {
    tctx = null;
  });
  return tctx;
}

const loggedIn = (page) => {
  const u = page.url();
  return u && !/\/login/i.test(u);
};

/** 在页面与所有 frame 里找二维码图形 */
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

module.exports = {
  register(app, ctx) {
    const { log } = ctx;
    let qrPoll = null;

    /** 扫码：拿二维码图 + 后台轮询登录成功 */
    app.post('/api/tiktok-login/qr', async (req, res) => {
      try {
        const c = await launch(ctx, true); // 全程无头
        const page = c.pages()[0] || (await c.newPage());
        await page.goto(LOGIN_QR, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4500);
        const qr = await findQr(page);
        if (!qr) return res.status(500).json({ error: '没找到二维码（页面结构可能变了）' });
        const shot = await qr.screenshot();
        // 后台轮询：扫码成功后 URL 离开 /login，或有 sessionid cookie
        if (qrPoll) clearInterval(qrPoll);
        qrPoll = setInterval(() => {
          (async () => {
            try {
              const pg = c.pages()[0];
              if (!pg) return;
              if (loggedIn(pg)) {
                clearInterval(qrPoll);
                qrPoll = null;
                log('✅ TikTok 扫码登录成功（会话已存 data/profiles-tiktok）');
              }
            } catch (_) {}
          })();
        }, 2500);
        res.json({ ok: true, qr: shot.toString('base64'), note: '用手机 TikTok App 扫这个码' });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    /** 账密/邮箱 */
    app.post('/api/tiktok-login/password', async (req, res) => {
      const account = String((req.body && req.body.account) || '').trim();
      const password = String((req.body && req.body.password) || '');
      if (!account || !password) return res.status(400).json({ error: '账号密码都要有' });
      try {
        const c = await launch(ctx, true);
        const page = c.pages()[0] || (await c.newPage());
        await page.goto(LOGIN_PWD, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4000);
        // 登录表单可能在 iframe 里：所有 frame 都试
        const frames = [page.mainFrame()].concat(page.frames());
        let filled = false;
        for (const f of frames) {
          try {
            const acc = await f.$('input[name=username], input[name=email], input[type=text]');
            const pwd = await f.$('input[type=password]');
            if (acc && pwd) {
              await acc.fill(account, { timeout: 5000 }).catch(() => {});
              await pwd.fill(password, { timeout: 5000 }).catch(() => {});
              filled = true;
              break;
            }
          } catch (_) {}
        }
        if (!filled) throw new Error('没找到登录表单');
        for (const f of frames) {
          try { await f.click('button[type=submit]', { timeout: 2000 }); break; } catch (_) {}
        }
        for (let i = 0; i < 25; i++) {
          await page.waitForTimeout(1000);
          if (loggedIn(page)) return res.json({ ok: true, loggedIn: true });
        }
        res.json({ needManual: true, reason: '出现验证/或凭据有误', note: '验证码处理逻辑与卖家中心一致' });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/tiktok-login/status', async (req, res) => {
      try {
        if (!tctx) {
          // 冷启动检查：无头开一次看是否已登录（profile 里有会话）
          const c = await launch(ctx, true);
          const pg = c.pages()[0] || (await c.newPage());
          await pg.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          await pg.waitForTimeout(3000);
          return res.json({ loggedIn: loggedIn(pg), url: pg.url().slice(0, 120) });
        }
        const pg = tctx.pages()[0];
        return res.json({ open: true, loggedIn: pg ? loggedIn(pg) : false });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    log('TikTok 登录模块已挂载：/api/tiktok-login/*');
  },
};

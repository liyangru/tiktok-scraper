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

function profileDir(ctx, name) {
  const d = path.join(ctx.baseDir, 'data', 'profiles-tiktok', name || 'default');
  fs.mkdirSync(d, { recursive: true });
  return d;
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

/** 后台心跳：每 1.5 秒刷新阶段（「不卡顿」的关键 —— 状态永远最新） */
function startTicker(ctx) {
  if (ticker) clearInterval(ticker);
  ticker = setInterval(async () => {
    if (!pageRef || !ctxRef) return;
    try {
      if (await isLoggedIn(ctxRef, pageRef)) {
        set('logged-in', '登录成功');
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

async function ensureSession(ctx, name) {
  profileName = name || profileName || 'default';
  if (ctxRef) return ctxRef;
  const chromium = ctx.core.chromium;
  if (!chromium) throw new Error('核心没有提供 chromium');
  const exe = ctx.core.scraper.resolveChromePath();
  ctxRef = await chromium.launchPersistentContext(profileDir(ctx, profileName), {
    headless: true,
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

module.exports = {
  register(app, ctx) {
    const { log } = ctx;

    /** 开始登录：**立即返回**，后台加载；前端轮询 /state 看进度 */
    app.post('/api/tiktok-login/start', async (req, res) => {
      const account = String((req.body && req.body.account) || '').trim();
      const mode = (req.body && req.body.mode) === 'password' ? 'password' : 'qr';
      res.json({ ok: true, started: true });
      (async () => {
        try {
          set('launching', '正在启动浏览器…', { qr: '', inputKind: '', account });
          await closeSession();
          const c = await ensureSession(ctx, account);
          set('loading', '正在打开登录页…');
          const page = c.pages()[0] || (await c.newPage());
          pageRef = page;
          startTicker(ctx);
          await page.goto(mode === 'qr' ? QR_URL : PWD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(2500);
          if (mode === 'qr') {
            const qr = await findQr(page);
            if (qr) {
              const shot = await qr.screenshot();
              set('waiting-scan', '请用手机 TikTok 扫码', { qr: shot.toString('base64'), inputKind: '' });
            } else {
              set('loading', '正在加载二维码…');
            }
          } else {
            set('need-input', '请输入账号与密码后提交', { inputKind: 'account' });
          }
        } catch (e) {
          set('error', '打开登录页失败：' + e.message);
        }
      })();
    });

    /** 状态查询（即时，不启动任何东西） */
    app.get('/api/tiktok-login/state', (req, res) => {
      res.json({
        phase: S.phase,
        message: S.message,
        qr: S.qr,
        inputKind: S.inputKind,
        account: S.account,
        loggedIn: S.phase === 'logged-in',
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

    /** 关闭会话 / 退出 */
    app.post('/api/tiktok-login/close', async (req, res) => {
      await closeSession();
      set('idle', '');
      res.json({ ok: true });
    });

    /** 已登录账号列表（多账号：每个 profile 目录 = 一个账号） */
    app.get('/api/tiktok-login/accounts', (req, res) => {
      const root = path.join(ctx.baseDir, 'data', 'profiles-tiktok');
      let names = [];
      try {
        names = fs.readdirSync(root).filter((f) => {
          try {
            return fs.statSync(path.join(root, f)).isDirectory();
          } catch (_) {
            return false;
          }
        });
      } catch (_) {}
      res.json({ accounts: names, current: profileName });
    });

    log('TikTok 登录模块已挂载：/api/tiktok-login/*（常驻会话 + 实时状态）');
  },
};

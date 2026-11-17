/**
 * 模块：TikTok Shop 开放平台（Partner API）
 *
 * 为什么走官方 API：
 *   浏览器导出那套依赖页面结构（导出按钮文案、表格列序），TikTok 一改版就断；
 *   官方 API 有版本号、有明确错误码，且能自动化、能按日期区间反复拉。
 *
 * ── 三条链路（前两步只做一次，之后只走第三步）──────────────────────
 *   ① 应用配置：App Key / App Secret / Service ID 写进 <BASE_DIR>/.env（密钥永不进 settings.json）
 *   ② 商家授权：打开 https://services.tiktokshop.com/open/authorize?service_id=<id>
 *      商家在自己账号里点同意 → 跳回回调地址并带上一次性的 code
 *      → 我们用 code 换 access_token / refresh_token（token 有效期 7 天，refresh 长得多）
 *   ③ 拉数据：/analytics/202409/shop_videos/performance 按日期区间取「店铺视频业绩」，
 *      按视频ID合并进明细行（GMV / 订单 / 商品点击 / 点击率 / 销量 / 涨粉）。
 *
 * ── 实测得到的关键事实（别再猜）──────────────────────────────────
 *   · token 换取/刷新：GET https://auth.tiktok-shops.com/api/v2/token/get
 *                     GET https://auth.tiktok-shops.com/api/v2/token/refresh
 *     grant_type 是 `authorized_code`（不是 authorization_code），app_secret 走 query。
 *   · 业务 API 基址：https://open-api.tiktokglobalshop.com，路径形如 /authorization/202309/shops
 *   · 202309 起 access_token **不再进签名**，改放请求头 `x-tts-access-token`。
 *   · 签名 = HMAC-SHA256(app_secret, app_secret + path + 按 key 排序拼接的 query + body + app_secret)，
 *     十六进制。query 里要排除 sign 与 access_token。官方给的测试向量：
 *       secret=e59af819cc path=/authorization/202309/shops app_key=29a39d timestamp=1623812664
 *       → b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8
 *     本文件 /selftest 会跑这条向量，签名一改错立刻能看出来。
 *   · 店铺视频业绩端点（202409）：
 *       GET /analytics/202409/shop_videos/performance          列表
 *       GET /analytics/202409/shop_videos/overview_performance 概览
 *       GET /analytics/202409/shop_videos/{video_id}/performance 单条
 *       GET /analytics/202409/shop_videos/{video_id}/products/performance 单条的带货商品
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ==================== 常量 ==================== */
const AUTH_BASE = 'https://auth.tiktok-shops.com';
const API_BASE = 'https://open-api.tiktokglobalshop.com';
const AUTHORIZE_URL = (serviceId) => `https://services.tiktokshop.com/open/authorize?service_id=${encodeURIComponent(serviceId)}`;
const PATH_SHOPS = '/authorization/202309/shops';
const PATH_VIDEO_PERF = '/analytics/202409/shop_videos/performance';
const PATH_VIDEO_OVERVIEW = '/analytics/202409/shop_videos/overview_performance';

/** 官方文档给的签名测试向量（改签名算法时必须仍然通过） */
const SIGN_VECTOR = {
  secret: 'e59af819cc',
  apiPath: '/authorization/202309/shops',
  params: { app_key: '29a39d', timestamp: '1623812664' },
  expect: 'b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8',
};

/* ==================== 签名 ==================== */
/**
 * TikTok Shop 签名：HMAC-SHA256(app_secret, secret + path + 排序后的 query + body + secret)
 * query 按 **key 升序**，拼成 `keyvalue` 无分隔符；排除 sign 与 access_token。
 * ⚠️ 必须签「实际发出去的那串 body 字节」，序列化两次会因空白/转义不同而对不上。
 */
function signRequest(appSecret, apiPath, params, bodyStr) {
  const keys = Object.keys(params || {})
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort();
  const joined = keys.map((k) => `${k}${params[k]}`).join('');
  const base = `${appSecret}${apiPath}${joined}${bodyStr || ''}${appSecret}`;
  return crypto.createHmac('sha256', appSecret).update(base, 'utf8').digest('hex');
}

function signSelfTest() {
  const got = signRequest(SIGN_VECTOR.secret, SIGN_VECTOR.apiPath, SIGN_VECTOR.params, '');
  return { ok: got === SIGN_VECTOR.expect, got, expect: SIGN_VECTOR.expect };
}

module.exports = {
  register(app, ctx) {
    const { log, envfile } = ctx;
    const ENV_FILE = ctx.settings && ctx.settings.ENV_FILE ? ctx.settings.ENV_FILE : path.join(ctx.baseDir, '.env');

    /* ==================== 存储 ==================== */
    const dataDir = path.join(ctx.baseDir, 'data', 'seller-api');
    const tokenFile = path.join(dataDir, 'token.json');
    const videosFile = path.join(dataDir, 'videos.json');

    const readJson = (f, dflt) => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (_) {
        return dflt;
      }
    };
    const writeJson = (f, o) => {
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(o, null, 2), { mode: 0o600 });
      } catch (e) {
        ctx.log(`写 ${path.basename(f)} 失败：${e.message}`);
      }
    };

    /** 应用密钥只从 .env 读（每读一次都重新读盘，设置页刚保存的立刻生效） */
    const cfg = () => {
      const e = envfile.read(ENV_FILE);
      return {
        appKey: (e.TTS_APP_KEY || '').trim(),
        appSecret: (e.TTS_APP_SECRET || '').trim(),
        serviceId: (e.TTS_SERVICE_ID || '').trim(),
        currency: (e.TTS_CURRENCY || '').trim(),
      };
    };
    /**
     * 令牌存储。⚠️ 老版本把 access_token 放在 .env 里（TTS_ACCESS_TOKEN），
     * 所以这里做一次兼容：本地没存过 token 但 .env 里有，就先拿来用（不用重新授权）。
     */
    const store = () => {
      const s = readJson(tokenFile, { token: null, shop: null });
      if (!s.token || !s.token.access_token) {
        const e = envfile.read(ENV_FILE);
        if (e.TTS_ACCESS_TOKEN) {
          s.token = {
            access_token: e.TTS_ACCESS_TOKEN,
            access_expire_in: Number(e.TTS_ACCESS_EXPIRE || 0),
            refresh_token: e.TTS_REFRESH_TOKEN || '',
            refresh_expire_in: 0,
            seller_name: e.TTS_SHOP_NAME || '',
            seller_base_region: e.TTS_SHOP_REGION || '',
            fromEnv: true,
          };
          if (e.TTS_SHOP_CIPHER) s.shop = { id: e.TTS_SHOP_ID || '', cipher: e.TTS_SHOP_CIPHER, name: e.TTS_SHOP_NAME || '', region: e.TTS_SHOP_REGION || '' };
        }
      }
      return s;
    };
    const saveStore = (s) => writeJson(tokenFile, s);

    const nowSec = () => Math.floor(Date.now() / 1000);

    /* ==================== 底层调用 ==================== */
    /**
     * 调开放平台业务接口。
     * @param {string} apiPath 形如 /authorization/202309/shops
     * @param {object} params  query（不含 app_key/timestamp/sign，这里自动补）
     * @param {object|null} body  JSON body
     */
    async function callApi(apiPath, params, body, opts) {
      const c = cfg();
      if (!c.appKey || !c.appSecret) throw new Error('还没有配置 App Key / App Secret');
      const token = (opts && opts.token) || (store().token || {}).access_token;
      if (!token) throw new Error('还没有授权（缺 access_token），请先点「开始授权」');

      const q = Object.assign({}, params);
      q.app_key = c.appKey;
      q.timestamp = String(nowSec());
      // ⚠️ 202309 起 token 走请求头，不进 query、也不进签名
      const bodyStr = body ? JSON.stringify(body) : '';
      q.sign = signRequest(c.appSecret, apiPath, q, bodyStr);

      const url = `${API_BASE}${apiPath}?${new URLSearchParams(q).toString()}`;
      const resp = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-tts-access-token': token,
        },
        ...(body ? { body: bodyStr } : {}),
      });
      const text = await resp.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {}
      return { status: resp.status, json, text: text.slice(0, 4000), url: url.replace(c.appSecret, '***') };
    }

    /** 带自动刷新：遇到「凭证过期」类错误先刷一次再重试 */
    async function callWithRefresh(apiPath, params, body) {
      let r = await callApi(apiPath, params, body);
      const code = r.json && r.json.code;
      if (code === 105002 || code === 105004 || code === 105005) {
        ctx.log(`接口返回 ${code}（凭证过期），尝试刷新 token 后重试`);
        const ok = await refreshToken().catch(() => false);
        if (ok) r = await callApi(apiPath, params, body);
      }
      return r;
    }

    /* ==================== 授权 / token ==================== */
    async function exchangeCode(code) {
      const c = cfg();
      if (!c.appKey || !c.appSecret) throw new Error('还没有配置 App Key / App Secret');
      const qs = new URLSearchParams({
        app_key: c.appKey,
        app_secret: c.appSecret,
        auth_code: code,
        grant_type: 'authorized_code',
      });
      const resp = await fetch(`${AUTH_BASE}/api/v2/token/get?${qs.toString()}`);
      const j = await resp.json().catch(() => null);
      // ⚠️ 这两个 URL 的 query 里带着 app_secret，任何日志/报错都必须先脱敏
      if (!j || (j.code !== 0 && !(j.data && j.data.access_token))) {
        throw new Error(`换取 token 失败：${(j && (j.message || j.msg)) || '返回结构不认识'}`);
      }
      saveToken(j.data);
      return j.data;
    }

    function saveToken(d) {
      const s = store();
      s.token = {
        access_token: d.access_token || '',
        access_expire_in: nowSec() + (Number(d.access_token_expire_in) || 0),
        refresh_token: d.refresh_token || (s.token && s.token.refresh_token) || '',
        refresh_expire_in: Number(d.refresh_token_expire_in) || (s.token && s.token.refresh_expire_in) || 0,
        seller_name: d.seller_name || '',
        seller_base_region: d.seller_base_region || '',
        open_id: d.open_id || '',
        user_type: d.user_type || '',
        granted_scopes: d.granted_scopes || '',
        at: new Date().toISOString(),
      };
      saveStore(s);
    }

    async function refreshToken() {
      const c = cfg();
      const s = store();
      const rt = s.token && s.token.refresh_token;
      if (!rt) throw new Error('没有 refresh_token，请重新授权');
      const qs = new URLSearchParams({
        app_key: c.appKey,
        app_secret: c.appSecret,
        refresh_token: rt,
        grant_type: 'refresh_token',
      });
      const resp = await fetch(`${AUTH_BASE}/api/v2/token/refresh?${qs.toString()}`);
      const j = await resp.json().catch(() => null);
      if (!j || (j.code !== 0 && !(j.data && j.data.access_token))) {
        throw new Error(`刷新 token 失败：${(j && (j.message || j.msg)) || '返回结构不认识'}`);
      }
      // 返回的 refresh_token 可能与传入的不同 —— 必须以返回的为准
      saveToken(j.data);
      ctx.log('access_token 已刷新');
      return true;
    }

    /** 取授权店铺；顺手把第一个店铺存成当前 shop（拿 shop_cipher） */
    async function fetchShops() {
      const r = await callWithRefresh(PATH_SHOPS, {});
      if (!r.json || r.json.code !== 0) {
        return { ok: false, error: (r.json && r.json.message) || `HTTP ${r.status}`, raw: r.json || r.text };
      }
      const shops = ((r.json.data && r.json.data.shops) || []).map((s) => ({
        id: s.id,
        cipher: s.cipher,
        name: s.name,
        region: s.region,
        seller_type: s.seller_type,
      }));
      if (shops.length) {
        const st = store();
        const keep = st.shop && shops.find((x) => x.id === st.shop.id);
        st.shop = keep || shops[0];
        st.shops = shops;
        saveStore(st);
      }
      return { ok: true, shops };
    }

    /* ==================== 商家授权（浏览器窗口 + 抓回调 code） ==================== */
    const AUTH = { phase: 'idle', message: '', url: '', code: '', at: 0 };
    let authCtx = null;
    let authWatcher = null;

    const setAuth = (phase, message, extra) => {
      AUTH.phase = phase;
      AUTH.message = message || '';
      Object.assign(AUTH, extra || {});
      AUTH.at = Date.now();
    };

    async function closeAuthWindow() {
      if (authWatcher) clearInterval(authWatcher);
      authWatcher = null;
      const c = authCtx;
      authCtx = null;
      if (c) await c.close().catch(() => {});
    }

    /**
     * 打开授权页并盯住回调。
     * ⚠️ 回调地址是商家在 Partner Center 里配的，可能是我们根本连不上的域名；
     *    所以**不依赖页面能加载成功** —— 直接监听导航请求的 URL，把 code 摘出来即可。
     */
    async function startAuthorize() {
      const c = cfg();
      if (!c.serviceId) throw new Error('还没有配置 Service ID');
      const url = AUTHORIZE_URL(c.serviceId);
      await closeAuthWindow();

      const chromium = ctx.core.chromium;
      if (!chromium) throw new Error('核心没有提供 chromium（需要 patchright）');
      const exe = ctx.core.scraper.resolveChromePath();
      const dir = path.join(ctx.baseDir, 'data', 'profiles-api');
      fs.mkdirSync(dir, { recursive: true });
      authCtx = await chromium.launchPersistentContext(dir, {
        headless: false, // 授权必须看得见：商家要登录并点同意
        viewport: { width: 1100, height: 820 },
        args: ['--no-first-run', '--disable-dev-shm-usage'],
        ...(exe ? { executablePath: exe } : {}),
      });
      const page = authCtx.pages()[0] || (await authCtx.newPage());
      const grab = (u) => {
        if (!u) return false;
        const m = /[?&]code=([^&#]+)/.exec(u);
        if (!m) return false;
        const code = decodeURIComponent(m[1]);
        if (!code || code.length < 8) return false;
        setAuth('got-code', '已拿到授权码，正在换取令牌…', { code });
        exchangeCode(code)
          .then(async () => {
            const s = await fetchShops().catch(() => ({ ok: false }));
            await closeAuthWindow();
            setAuth('done', s.ok ? `授权成功（店铺 ${((s.shops || [])[0] || {}).name || ''}）` : '授权成功，但取店铺列表失败');
          })
          .catch(async (e) => {
            await closeAuthWindow();
            setAuth('error', '换取令牌失败：' + e.message);
          });
        return true;
      };
      page.on('request', (r) => grab(r.url()));
      page.on('framenavigated', (f) => grab(f.url()));
      authCtx.on('close', () => { authCtx = null; if (AUTH.phase !== 'done') setAuth('idle', '授权窗口已关闭'); });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      setAuth('waiting', '请在打开的窗口里登录并点「同意授权」', { url });
      authWatcher = setInterval(async () => {
        try {
          if (!authCtx) return;
          for (const p of authCtx.pages()) if (grab(p.url())) return;
        } catch (_) {}
      }, 1200);
      return { url };
    }

    /* ==================== 数据：店铺视频业绩 ==================== */
    /** 把接口返回的一条视频业绩规范化成应用认识的字段（只放平台独有字段，重合的以 TikTok 抓取为准） */
    function normVideo(v) {
      if (!v || typeof v !== 'object') return null;
      const vid = String(v.item_id || v.id || v.video_id || '');
      if (!/^\d{6,}$/.test(vid)) return null;
      const num = (x) => {
        const n = Number(typeof x === 'object' && x ? x.amount : x);
        return Number.isFinite(n) ? n : undefined;
      };
      const out = {};
      const gmv = v.gmv && typeof v.gmv === 'object' ? num(v.gmv.amount !== undefined ? v.gmv : v.gmv.amount) : num(v.gmv);
      const gmvObj = v.gmv && typeof v.gmv === 'object' ? v.gmv : null;
      const gmvVal = gmvObj ? Number(gmvObj.amount) : Number(v.gmv);
      if (Number.isFinite(gmvVal)) out.gmv = gmvVal;
      if (gmvObj && gmvObj.currency) out.currency = gmvObj.currency;
      const map = [
        ['orders', ['orders', 'order_count']],
        ['productClicks', ['product_clicks']],
        ['productImpressions', ['product_impressions']],
        ['unitsSold', ['units_sold']],
        ['skuOrders', ['sku_orders']],
        ['newFans', ['new_followers']],
      ];
      for (const [key, names] of map) {
        for (const n of names) {
          const val = num(v[n]);
          if (val !== undefined) { out[key] = val; break; }
        }
      }
      const ctr = v.click_through_rate ?? v.ctr;
      if (ctr !== undefined && ctr !== null && ctr !== '') {
        const n = Number(ctr);
        if (Number.isFinite(n)) out.ctr = n <= 1 ? Math.round(n * 10000) / 100 : Math.round(n * 100) / 100;
      }
      if (Number.isFinite(gmvVal) && Number.isFinite(Number(v.views)) && Number(v.views) > 0) {
        out.gpm = Math.round((gmvVal / Number(v.views)) * 1000 * 100) / 100;
      }
      if (v.title) out.productNote = String(v.title).slice(0, 120);
      return Object.keys(out).length ? { vid, fields: out } : null;
    }

    /** 拉一批店铺视频业绩（自动翻页），返回 {vid: fields} */
    async function pullVideoPerformance({ days = 7, startDate, endDate, maxPages = 10 } = {}) {
      const c = cfg();
      const st = store();
      if (!st.shop || !st.shop.cipher) throw new Error('还没有 shop_cipher，请先授权并取店铺');
      const fmt = (d) => d.toISOString().slice(0, 10);
      const end = endDate || fmt(new Date());
      const start = startDate || fmt(new Date(Date.now() - (days - 1) * 86400000));

      const map = {};
      let pageToken = '';
      const tried = [];
      for (let i = 0; i < maxPages; i++) {
        const params = {
          shop_cipher: st.shop.cipher,
          start_date: start,
          end_date: end,
          page_size: 100,
        };
        if (pageToken) params.page_token = pageToken;
        if (c.currency) params.currency = c.currency;
        const r = await callWithRefresh(PATH_VIDEO_PERF, params, null);
        if (!r.json || r.json.code !== 0) {
          const msg = (r.json && r.json.message) || `HTTP ${r.status}`;
          if (!i) return { ok: false, error: msg, raw: r.json || r.text, params, tried };
          tried.push(`第 ${i + 1} 页失败：${msg}`);
          break;
        }
        const d = r.json.data || {};
        for (const v of d.videos || []) {
          const n = normVideo(v);
          if (n) map[n.vid] = Object.assign(map[n.vid] || {}, n.fields);
        }
        pageToken = d.next_page_token || '';
        tried.push(`第 ${i + 1} 页 ${(d.videos || []).length} 条（累计 ${Object.keys(map).length}）`);
        if (!pageToken) break;
      }
      const out = { at: Date.now(), start, end, shop: st.shop, map, pages: tried };
      writeJson(videosFile, out);
      return { ok: true, n: Object.keys(map).length, start, end, pages: tried };
    }

    /* ==================== 路由 ==================== */
    app.get('/api/seller-api/selftest', (req, res) => res.json(signSelfTest()));

    app.get('/api/seller-api/status', (req, res) => {
      const c = cfg();
      const st = store();
      const tok = st.token || null;
      const left = tok && tok.access_expire_in ? tok.access_expire_in - nowSec() : 0;
      res.json({
        configured: { appKey: !!c.appKey, appSecret: !!c.appSecret, serviceId: !!c.serviceId },
        serviceId: c.serviceId || '',
        appKeyTail: c.appKey ? c.appKey.slice(-4) : '',
        authorized: !!(tok && tok.access_token),
        token: tok
          ? {
              seller: tok.seller_name || '',
              region: tok.seller_base_region || '',
              userType: tok.user_type || '',
              scopes: tok.granted_scopes || '',
              expiresIn: left,
              expired: left <= 0,
              at: tok.at,
              hasRefresh: !!tok.refresh_token,
            }
          : null,
        shop: st.shop || null,
        shops: st.shops || [],
        videos: (readJson(videosFile, {}) || {}).map ? Object.keys(readJson(videosFile, {}).map || {}).length : 0,
        authorizeUrl: c.serviceId ? AUTHORIZE_URL(c.serviceId) : '',
      });
    });

    app.post('/api/seller-api/config', (req, res) => {
      const b = req.body || {};
      const patch = {};
      // 只写实际传了值的字段，留空表示「不改」——避免手滑把已存好的密钥清掉
      if (b.appKey && String(b.appKey).trim()) patch.TTS_APP_KEY = String(b.appKey).trim();
      if (b.appSecret && String(b.appSecret).trim()) patch.TTS_APP_SECRET = String(b.appSecret).trim();
      if (b.serviceId && String(b.serviceId).trim()) patch.TTS_SERVICE_ID = String(b.serviceId).trim();
      if (b.currency && String(b.currency).trim()) patch.TTS_CURRENCY = String(b.currency).trim();
      if (!Object.keys(patch).length) return res.status(400).json({ error: '没有要保存的内容' });
      try {
        envfile.write(ENV_FILE, patch);
      } catch (e) {
        return res.status(500).json({ error: '写入 .env 失败：' + e.message });
      }
      log(`开放平台配置已更新：${Object.keys(patch).join(', ')}`);
      res.json({ ok: true, saved: Object.keys(patch) });
    });

    app.post('/api/seller-api/authorize/start', async (req, res) => {
      try {
        const r = await startAuthorize();
        res.json({ ok: true, url: r.url });
      } catch (e) {
        setAuth('error', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/seller-api/authorize/state', (req, res) => {
      res.json({ phase: AUTH.phase, message: AUTH.message, url: AUTH.url, open: !!authCtx });
    });

    app.post('/api/seller-api/authorize/code', async (req, res) => {
      const code = String((req.body && req.body.code) || '').trim();
      if (!code) return res.status(400).json({ error: '请填写授权码' });
      try {
        await exchangeCode(code);
        const s = await fetchShops().catch(() => ({ ok: false }));
        setAuth('done', '授权成功');
        res.json({ ok: true, shops: s.shops || [], shop: (store() || {}).shop || null });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/seller-api/refresh', async (req, res) => {
      try {
        await refreshToken();
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/seller-api/shops', async (req, res) => {
      try {
        const r = await fetchShops();
        if (!r.ok) return res.status(502).json(r);
        res.json(r);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/seller-api/sync', async (req, res) => {
      try {
        const b = req.body || {};
        const r = await pullVideoPerformance({
          days: Number(b.days) || 7,
          startDate: b.startDate || '',
          endDate: b.endDate || '',
        });
        if (!r.ok) return res.status(502).json(r);
        log(`开放平台视频业绩：${r.n} 条（${r.start} ~ ${r.end}）`);
        res.json(r);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    /** 诊断：缓存里现在有多少条、样例长什么样 */
    app.get('/api/seller-api/videos', (req, res) => {
      const d = readJson(videosFile, { map: {} });
      const ids = Object.keys(d.map || {});
      res.json({ at: d.at || 0, start: d.start, end: d.end, n: ids.length, sample: ids.slice(0, 3).map((id) => ({ vid: id, ...(d.map[id] || {}) })) });
    });

    /** 诊断：直接打任意开放平台路径（排查新接口/字段用） */
    app.post('/api/seller-api/call', async (req, res) => {
      const b = req.body || {};
      const apiPath = String(b.path || '').trim();
      if (!/^\/[A-Za-z0-9_\-./]+$/.test(apiPath)) return res.status(400).json({ error: 'path 形如 /authorization/202309/shops' });
      try {
        const r = await callWithRefresh(apiPath, b.params || {}, b.body || null);
        res.json({ ok: !!(r.json && r.json.code === 0), status: r.status, json: r.json, text: r.json ? '' : r.text });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/seller-api/close', async (req, res) => {
      await closeAuthWindow();
      res.json({ ok: true });
    });

    /* ==================== 同步提供者 ====================
       注册进核心后，每次出报表都会把这里的商家指标合并到对应视频行。
       与 seller-import（xlsx 导出）共用 platform 'seller' —— 两者都是卖家中心口径，
       匹配上就说明这条视频确实带货（核心会把 isEC 置为 true）。 */
    if (typeof ctx.registerSync === 'function') {
      ctx.registerSync({
        platform: 'seller',
        collect: async () => {
          const d = readJson(videosFile, { map: {} });
          return d.map || {};
        },
      });
    }

    // 授权窗口是「可见窗口」，绝不能留着孤儿进程
    app.get('/api/seller-api/health', (req, res) => res.json({ ok: true, authWindow: !!authCtx, phase: AUTH.phase }));

    log('开放平台（Partner API）已挂载：/api/seller-api/*');
    log(`签名自检：${signSelfTest().ok ? '✅ 通过（与官方测试向量一致）' : '❌ 不通过，签名实现有问题'}`);
  },
};

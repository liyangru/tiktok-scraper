/*
 * TikTok 账号视频采集脚本 —— 在 Claude 内置浏览器（或 Chrome）的 tiktok.com 页面里执行
 *
 * 原理：在当前 TikTok 页面里开一个同源 iframe 加载账号主页，抢在 TikTok 读取接口响应之前
 * 给 iframe 的 Response.prototype.json/text 和 XHR 打补丁，拿到页面自己请求的 item_list 原始数据
 * （签名由 TikTok 自己完成，不伪造请求）；然后在 iframe 里往下滚动，直到加载到起始日期之前。
 *
 * 浏览器面板隐藏时 TikTok 默认不加载视频列表：脚本在 iframe 里把页面标记为「可见」、
 * 用定时器代替被暂停的 requestAnimationFrame / IntersectionObserver，所以面板收起来也能继续采集。
 * 卡住时自动处理：先上下滚动触发懒加载，还不行就刷新页面继续（最多 3 次），已拿到的数据保留。
 *
 * 用法（javascript_tool，可多次调用，同一账号会续跑，不会重复开始）：
 *   await TTC({ handle: 'loopearplugs.th', from: '2026-10-01', to: '2026-11-17', wait: 25 })
 * 返回：
 *   进行中 { status:'running', handle, found, reached, pages, elapsed }
 *   完成   { status:'done', handle, profile:{...}, complete, oldestDate, items:[[...]], fields:[...] }
 *   失败   { status:'error', error }
 *   items 是紧凑二维数组（省 token），字段顺序见 fields。
 */
(() => {
  const W = window;
  const FIELDS = ['id', 'createTime', 'views', 'likes', 'comments', 'shares', 'saves', 'reposts', 'duration', 'cart', 'ad', 'pinned', 'desc'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const BKK = 7 * 3600 * 1000;
  const dayTs = (d, end) => Math.floor((Date.parse(d + (end ? 'T23:59:59Z' : 'T00:00:00Z')) - BKK) / 1000);
  const dateOf = (ts) => new Date(ts * 1000 + BKK).toISOString().slice(0, 10);
  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

  function compact(it) {
    const s = it.stats || {};
    const s2 = it.statsV2 || {};
    const pick = (a, b) => num(s2[b] !== undefined ? s2[b] : s[a]);
    const isEC = !!(it.isECVideo || (it.anchors && it.anchors.length) || (it.products && it.products.length) || it.commerceInfo || (it.productInfo && it.productInfo.length));
    return [
      String(it.id),
      it.createTime || 0,
      pick('playCount', 'playCount'),
      pick('diggCount', 'diggCount'),
      pick('commentCount', 'commentCount'),
      pick('shareCount', 'shareCount'),
      pick('collectCount', 'collectCount'),
      pick('repostCount', 'repostCount'),
      (it.video && it.video.duration) || 0,
      isEC ? 1 : 0,
      it.isAd ? 1 : 0,
      it.isPinnedItem ? 1 : 0,
      String(it.desc || '').replace(/\s+/g, ' ').slice(0, 40),
    ];
  }

  /** 账号信息：优先用接口里的 author / authorStats（精确数字），拿不到再读页面头部 */
  function profileOf(st, doc) {
    if (st.author) return st.author;
    const q = (sel) => ((doc && doc.querySelector(sel)) || {}).textContent || '';
    return { handle: st.handle, nickname: q('[data-e2e="user-subtitle"]'), followers: q('[data-e2e="followers-count"]'), likes: q('[data-e2e="likes-count"]') };
  }

  function start(o) {
    const st = {
      handle: o.handle,
      from: o.from,
      to: o.to,
      status: 'running',
      items: new Map(),
      pages: 0,
      hasMore: true,
      oldest: Infinity, // 非置顶视频里最早的发布时间
      startedAt: Date.now(),
      reloads: 0,
      error: null,
      author: null,
    };
    W.__ttc = st;

    const rec = (url, body) => {
      if (!String(url || '').includes('/api/post/item_list')) return;
      let j = body;
      if (typeof j === 'string') {
        try {
          j = JSON.parse(j);
        } catch (_) {
          return;
        }
      }
      if (!j || !Array.isArray(j.itemList)) return;
      st.pages++;
      for (const it of j.itemList) {
        if (!it || !it.id) continue;
        // 只要这个账号自己的作品（防止推荐流混进来）
        if (it.author && it.author.uniqueId && it.author.uniqueId.toLowerCase() !== o.handle.toLowerCase()) continue;
        if (!st.author && it.author) {
          const a = it.authorStats || {};
          st.author = { handle: it.author.uniqueId, nickname: it.author.nickname || '', followers: num(a.followerCount), likes: num(a.heartCount), videos: num(a.videoCount), verified: !!it.author.verified };
        }
        if (st.items.has(String(it.id))) continue;
        st.items.set(String(it.id), compact(it));
        if (!it.isPinnedItem && it.createTime) st.oldest = Math.min(st.oldest, it.createTime);
      }
      if (typeof j.hasMore === 'boolean') st.hasMore = j.hasMore;
      // 有的页 itemList 是空的但游标照样往前走：游标（毫秒时间戳）也算进度
      const c = Number(j.cursor);
      if (Number.isFinite(c) && c > 1e12 && c !== st.cursor) {
        st.cursor = c;
        st.moved = Date.now();
        if (st.pages > 1) st.oldest = Math.min(st.oldest, Math.floor(c / 1000));
      }
    };

    /** 开 / 重开采集用的 iframe，并在 TikTok 读取响应前打上补丁 */
    function attach() {
      if (st.frame) st.frame.remove();
      if (st.patchTimer) clearInterval(st.patchTimer);
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;border:0;background:#fff';
      f.src = '/@' + encodeURIComponent(o.handle) + '?lang=zh-Hans';
      const seen = new WeakSet();
      st.patchTimer = setInterval(() => {
        try {
          const w = f.contentWindow;
          if (!w || seen.has(w) || !w.Response) return;
          seen.add(w);
          // 面板隐藏时也照常加载：页面始终「可见」，动画帧和可见性观察用定时器驱动
          try {
            const D = w.Document.prototype;
            Object.defineProperty(D, 'hidden', { configurable: true, get: () => false });
            Object.defineProperty(D, 'visibilityState', { configurable: true, get: () => 'visible' });
            w.document.hasFocus = () => true;
            w.requestAnimationFrame = (cb) => w.setTimeout(() => cb(w.performance.now()), 16);
            w.cancelAnimationFrame = (id) => w.clearTimeout(id);
            const NativeIO = w.IntersectionObserver;
            w.IntersectionObserver = class {
              constructor(cb, opt) {
                this.cb = cb;
                this.t = new Set();
                this.native = NativeIO ? new NativeIO(cb, opt) : null;
                this.iv = w.setInterval(() => {
                  if (!this.t.size) return;
                  const vh = w.innerHeight || 800;
                  const list = [...this.t].map((target) => {
                    const r = target.getBoundingClientRect();
                    const on = r.bottom > -vh && r.top < vh * 2; // 视口上下各多算一屏
                    return { target, isIntersecting: on, intersectionRatio: on ? 1 : 0, boundingClientRect: r, intersectionRect: r, rootBounds: null, time: w.performance.now() };
                  });
                  try { this.cb(list, this); } catch (_) {}
                }, 800);
              }
              observe(t) { this.t.add(t); if (this.native) this.native.observe(t); }
              unobserve(t) { this.t.delete(t); if (this.native) this.native.unobserve(t); }
              disconnect() { this.t.clear(); w.clearInterval(this.iv); if (this.native) this.native.disconnect(); }
              takeRecords() { return []; }
            };
          } catch (_) {}
          const R = w.Response.prototype;
          const oj = R.json;
          const ot = R.text;
          R.json = async function () {
            const j = await oj.call(this);
            try { rec(this.url, j); } catch (_) {}
            return j;
          };
          R.text = async function () {
            const t = await ot.call(this);
            try { rec(this.url, t); } catch (_) {}
            return t;
          };
          const X = w.XMLHttpRequest.prototype;
          const oo = X.open;
          const os = X.send;
          X.open = function (m, u) {
            this.__ttu = u;
            return oo.apply(this, arguments);
          };
          X.send = function () {
            this.addEventListener('load', () => {
              try { rec(this.__ttu, this.responseType === '' || this.responseType === 'text' ? this.responseText : this.response); } catch (_) {}
            });
            return os.apply(this, arguments);
          };
        } catch (_) {}
      }, 3);
      st.frame = f;
      W.__ttcFrame = f;
      document.body.appendChild(f);
      return f;
    }

    const stopBefore = dayTs(o.from) - 3 * 86400; // 多加载 3 天，确认起始日期之前没有漏的
    const MAX_RELOADS = 3;
    (async () => {
      try {
        attach();
        // 等首屏；拿不到就刷新重试
        for (;;) {
          for (let i = 0; i < 30 && !st.pages; i++) await sleep(500);
          if (st.pages) break;
          const d = st.frame.contentDocument;
          const txt = d && d.body ? d.body.innerText : '';
          if (/找不到|Couldn't find|ไม่พบ/.test(txt)) throw new Error('找不到这个账号');
          if (st.reloads >= MAX_RELOADS) throw new Error('TikTok 没有返回视频列表：请刷新页面、重新执行脚本后再试');
          st.reloads++;
          attach();
        }
        let still = 0;
        let last = '';
        for (let i = 0; i < 600; i++) {
          if (!st.hasMore || st.oldest < stopBefore) break;
          const f = st.frame;
          const d = f.contentDocument;
          const w = f.contentWindow;
          if (!d || !w) {
            await sleep(500);
            continue;
          }
          const tiles = d.querySelectorAll('[data-e2e="user-post-item"]');
          if (tiles.length) tiles[tiles.length - 1].scrollIntoView({ block: 'end' });
          w.scrollBy(0, 2400);
          w.dispatchEvent(new w.Event('scroll'));
          await sleep(1300);
          const mark = st.items.size + ':' + st.cursor;
          if (mark === last) still++;
          else {
            still = 0;
            last = mark;
          }
          // 卡住了：先上下晃一下触发懒加载；还不行就刷新页面继续（已拿到的数据保留）
          if (still === 4 || still === 7) {
            w.scrollBy(0, -1800);
            await sleep(700);
            w.scrollBy(0, 4000);
          } else if (still >= 10) {
            if (st.reloads >= MAX_RELOADS) break;
            st.reloads++;
            attach();
            for (let k = 0; k < 30 && st.frame.contentDocument && !st.frame.contentDocument.querySelector('[data-e2e="user-post-item"]'); k++) await sleep(500);
            still = 0;
          }
        }
        st.profile = profileOf(st, st.frame.contentDocument);
        st.complete = !st.hasMore || st.oldest < dayTs(o.from);
        st.status = 'done';
      } catch (e) {
        st.status = 'error';
        st.error = e.message || String(e);
      } finally {
        clearInterval(st.patchTimer);
        setTimeout(() => st.frame && st.frame.remove(), 300);
      }
    })();
    return st;
  }

  function view(st) {
    const base = { handle: st.handle, found: st.items.size, reloads: st.reloads, elapsed: Math.round((Date.now() - st.startedAt) / 1000) };
    if (st.status === 'running') return { status: 'running', ...base, reached: Number.isFinite(st.oldest) ? dateOf(st.oldest) : null };
    if (st.status === 'error') return { status: 'error', ...base, error: st.error };
    const lo = dayTs(st.from);
    const hi = dayTs(st.to, true);
    const items = [...st.items.values()].filter((r) => r[1] >= lo && r[1] <= hi).sort((a, b) => b[1] - a[1]);
    return {
      status: 'done',
      ...base,
      from: st.from,
      to: st.to,
      complete: st.complete,
      oldestDate: Number.isFinite(st.oldest) ? dateOf(st.oldest) : null,
      profile: st.profile,
      fields: FIELDS,
      items,
    };
  }

  W.TTC = async function (o) {
    if (!o || !o.handle || !o.from || !o.to) throw new Error('需要 handle / from / to');
    o.handle = String(o.handle).replace(/^@/, '').trim();
    const st = W.__ttc;
    const same = st && st.handle === o.handle && st.from === o.from && st.to === o.to && st.status !== 'error';
    const cur = same ? st : start(o);
    const until = Date.now() + Math.min(30, o.wait || 25) * 1000; // 工具单次调用约 45 秒超时
    while (cur.status === 'running' && Date.now() < until) await sleep(500);
    return view(cur);
  };
  return 'TTC ready';
})();

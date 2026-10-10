/**
 * 模块：视频下载
 *
 * 四种模式：单个链接 / 批量链接 / 整个主页 / 直接给 vid
 * 优先取「无水印源流」与「最高清晰度」—— 即从 video.playAddr / bitrateInfo 里挑，
 * 而不是用带水印的 downloadAddr。
 *
 * ⚠️ 实测背景（别改回去）：
 *   - item_list 里只有约 4 成视频带 playAddr，最新发布的常常没有 → 必须能回退到视频详情页
 *   - 详情页的数据要**拦截 /api/item/detail/ 响应**，不能靠解析 DOM
 *   - video.definition 是网页播放档位（常年 540p），真实清晰度在 bitrateInfo[].GearName
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const jobs = new Map();
let seq = 0;

/* ---------------- 工具 ---------------- */

/** 从各种形态的输入里抽出 { handle, vid } */
function parseVideoRef(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  // 纯数字 → 当成 vid
  if (/^\d{15,25}$/.test(t)) return { handle: '', vid: t };
  // 完整链接
  const m = /tiktok\.com\/@([^/]+)\/video\/(\d+)/.exec(t);
  if (m) return { handle: m[1], vid: m[2] };
  // 短链 v.tiktok.com / vm.tiktok.com → 交给浏览器跟随跳转
  if (/v\.tiktok\.com|vm\.tiktok\.com/.test(t)) return { handle: '', vid: '', short: t };
  return null;
}

/** 从 video 对象挑出可下载档位（按码率降序），并给出无水印首选地址 */
function pickStreams(v) {
  const out = [];
  const bi = v && v.bitrateInfo;
  if (Array.isArray(bi)) {
    for (const b of bi) {
      const pa = b.PlayAddr;
      const list = pa && (pa.UrlList || pa.urlList);
      const url = Array.isArray(list) && list.length ? list[0] : '';
      if (!url) continue;
      const m = /(\d{3,4})/.exec(b.GearName || '');
      out.push({
        gear: b.GearName || '',
        quality: m ? m[1] + 'p' : '',
        bitrate: Number(b.Bitrate) || 0,
        size: Number(pa && pa.DataSize) || 0,
        url,
      });
    }
  }
  out.sort((a, b) => b.bitrate - a.bitrate);
  // 回退：playAddr（通常无水印）→ downloadAddr（带水印，最后手段）
  const flat = (c) => {
    if (!c) return '';
    if (typeof c === 'string') return c;
    const l = c.UrlList || c.urlList;
    return Array.isArray(l) && l.length ? l[0] : '';
  };
  const fallback = flat(v && v.playAddr) || flat(v && v.downloadAddr);
  return { streams: out, fallback };
}

/** 从详情响应里挖出 item 对象（兼容几种外壳） */
function digItem(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.itemInfo && json.itemInfo.itemStruct) return json.itemInfo.itemStruct;
  if (Array.isArray(json.itemList) && json.itemList.length) return json.itemList[0];
  if (json.aweme_detail) return json.aweme_detail;
  return null;
}

/** 在视频详情页里拦截 item detail 响应 */

/**
 * 用公开解析服务拿无水印直链（主路径）。
 * 为什么用它：① 不依赖浏览器会话 ② 不用跟 TikTok 的签名/风控纠缠
 *   ③ 实测返回 hdplay/play/wmplay + 时长 + 封面，直接可下。
 * 失败时由调用方回退到「详情页解析」。
 */
async function resolveViaTikwm(core, url) {
  const api = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(url);
  const r = await fetch(api, {
    headers: { 'User-Agent': (core && core.scraper && core.scraper.UA) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error('tikwm HTTP ' + r.status);
  const j = await r.json();
  if (j.code !== 0 || !j.data) throw new Error(j.msg || 'tikwm 返回异常');
  const d = j.data;
  const best = d.hdplay || d.play || d.wmplay;
  if (!best) throw new Error('tikwm 未返回播放地址');
  return {
    vid: String(d.id || ''),
    url,
    desc: String(d.title || '').replace(/\n/g, ' ').trim(),
    author: (d.author && d.author.unique_id) || '',
    duration: d.duration || 0,
    cover: d.cover || '',
    streams: [],
    playUrl: best,
    watermarked: !(d.hdplay || d.play),
    source: 'tikwm',
  };
}

async function resolveOne(ctx, ref, log) {
  const page = await ctx.newPage();
  try {
    let hit = null;
    page.on('response', async (r) => {
      const u = r.url();
      if (!/\/api\/item\/detail\//.test(u) || hit) return;
      try {
        const j = await r.json();
        const it = digItem(j);
        if (it && !hit) hit = it;
      } catch (_) {}
    });

    const url = ref.short
      ? ref.short
      : ref.handle
        ? `https://www.tiktok.com/@${ref.handle}/video/${ref.vid}`
        : `https://www.tiktok.com/@_/video/${ref.vid}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // 短链跳转后从最终 URL 里补出 handle / vid
    const finalUrl = page.url();
    const m = /tiktok\.com\/@([^/]+)\/video\/(\d+)/.exec(finalUrl);
    if (m) {
      ref.handle = ref.handle || m[1];
      ref.vid = ref.vid || m[2];
    }
    for (let i = 0; i < 15 && !hit; i++) await page.waitForTimeout(400);

    // ⚠️ 关键修复：接口有时返回「残缺对象」（有 id、没播放地址），
    //    旧逻辑只在 hit 为空时才读内嵌 JSON → 结果拿到残缺对象，pickStreams 出不来直链，
    //    下载就报「没有可用的播放地址」（用户实测）。
    //    现在：只要**没有可用播放地址**就去读内嵌 JSON，并优先用有直链的那份。
    const hasStream = (x) => !!(x && x.video && (x.video.playAddr || (Array.isArray(x.video.bitrateInfo) && x.video.bitrateInfo.length)));
    if (!hasStream(hit)) {
      const raw = await page.evaluate(() => {
        const s = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        return s ? s.textContent : '';
      });
      if (raw) {
        try {
          const j = JSON.parse(raw);
          const scope = (j && j.__DEFAULT_SCOPE__) || {};
          const vd = scope['webapp.video-detail'];
          const it = vd && vd.itemInfo && vd.itemInfo.itemStruct;
          // 内嵌 JSON 更全（playAddr 必有、bitrateInfo 常有多档）→ 优先用它
          if (it && hasStream(it)) hit = it;
          else if (it && !hit) hit = it;
        } catch (_) {}
      }
    }
    return hit;
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

/** 用核心抓取器拿整个主页的视频（已有 playUrl 的直接用） */
async function resolveByHandle(core, handle, opts, log) {
  const ctx = await core.scraper.openSession(0);
  try {
    const r = await core.scraper.scrapeAccount(ctx, handle, opts);
    return r.items.map((it) => ({ it }));
  } finally {
    try { await ctx.close(); } catch (_) {}
  }
}

/* ---------------- 下载 ---------------- */

function defaultOutDir(cfg) {
  if (cfg && cfg.outDir) return cfg.outDir;
  return path.join(os.homedir(), 'Downloads', 'TikTokScraper');
}

function safeName(s, max = 60) {
  return String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, max) || 'video';
}

/**
 * 裸 HTTP 下载 —— 仅作为「没有浏览器会话可用」时的兜底。
 * ⚠️ 实测：TikTok 的播放地址与抓取浏览器的会话绑定（cookie），裸请求大概率 403。
 */
async function fetchTo(url, dest, ua) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': ua,
      Range: 'bytes=0-',
      Referer: 'https://www.tiktok.com/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return fs.statSync(dest).size;
}

/**
 * 用抓取浏览器的会话下载 —— **首选路径**。
 * ctx.request 自动带上该会话的 cookie 和 UA（播放地址就是绑在它上面的），
 * 这也是为什么裸 fetch 会 403 而它能过。
 */
async function fetchViaBrowser(bctx, url, dest) {
  const resp = await bctx.request.get(url, { headers: { Referer: 'https://www.tiktok.com/' } });
  if (!resp.ok()) throw new Error(`HTTP ${resp.status()}（CDN 拒绝，可能地址过期或被限流）`);
  const buf = await resp.body();
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/* ---------------- 注册 ---------------- */

module.exports = {
  register(app, ctx) {
    const { core, config, log } = ctx;

    /** 解析：把输入变成「可下载条目」列表（不落盘） */
    app.post('/api/video-download/resolve', async (req, res) => {
      const mode = (req.body && req.body.mode) || 'urls';
      const input = String((req.body && req.body.input) || '').trim();
      if (!input) return res.status(400).json({ error: '输入为空' });
      const out = [];
      const errors = [];

      try {
        if (mode === 'handle') {
          log(`解析主页 @${input}`);
          const list = await resolveByHandle(core, input.replace(/^@/, ''), {
            from: req.body.from,
            to: req.body.to,
          }, log);
          for (const { it } of list) {
            const { streams, fallback } = pickStreams(it.video || {});
            out.push({
              vid: (it.video && it.video.id) || String(it.id),
              url: `https://www.tiktok.com/@${input.replace(/^@/, '')}/video/${it.id}`,
              desc: (it.desc || '').replace(/\n/g, ' ').trim(),
              author: (it.author && it.author.uniqueId) || input,
              duration: (it.video && it.video.duration) || 0,
              cover: (it.video && (it.video.cover || it.video.originCover)) || '',
              streams,
              playUrl: fallback,
              watermarked: !fallback || !(it.video && it.video.playAddr),
            });
          }
        } else {
          const refs = input.split(/[\s,]+/).map(parseVideoRef).filter(Boolean);
          if (!refs.length) return res.status(400).json({ error: '没解析出有效的视频链接或 vid' });
          const needPage = refs.filter((r) => !r.vid || r.short || true); // 单条一律走详情页，拿最全
          const session = await core.scraper.openSession(0);
          try {
            for (const ref of refs) {
              // ① 主路径：公开解析服务（不依赖浏览器，最快最稳）
              const pageUrl = ref.short
                ? ref.short
                : ref.handle
                  ? `https://www.tiktok.com/@${ref.handle}/video/${ref.vid}`
                  : `https://www.tiktok.com/@_/video/${ref.vid}`;
              try {
                const fast = await resolveViaTikwm(core, pageUrl);
                if (fast.playUrl) {
                  out.push(fast);
                  continue;
                }
              } catch (e) {
                log(`tikwm 解析失败，回退详情页：${e.message}`);
              }
              // ② 回退：详情页解析（浏览器会话）
              try {
                const it = await resolveOne(session, ref, log);
                if (!it) {
                  errors.push(`${ref.vid || ref.short}: 未拿到详情（可能被限流或视频不存在）`);
                  continue;
                }
                const { streams, fallback } = pickStreams(it.video || {});
                out.push({
                  vid: (it.video && it.video.id) || ref.vid || String(it.id),
                  url: `https://www.tiktok.com/@${(it.author && it.author.uniqueId) || ref.handle || '_'}/video/${it.id}`,
                  desc: (it.desc || '').replace(/\n/g, ' ').trim(),
                  author: (it.author && it.author.uniqueId) || ref.handle || '',
                  duration: (it.video && it.video.duration) || 0,
                  cover: (it.video && (it.video.cover || it.video.originCover)) || '',
                  streams,
                  playUrl: fallback,
                  watermarked: !fallback || !(it.video && it.video.playAddr),
                });
              } catch (e) {
                errors.push(`${ref.vid || ref.short}: ${e.message}`);
              }
            }
          } finally {
            try { await session.close(); } catch (_) {}
          }
        }
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }

      res.json({ ok: true, count: out.length, items: out, errors });
    });

    /** 下载：把已解析的条目落盘 */
    app.post('/api/video-download/fetch', async (req, res) => {
      const items = (req.body && req.body.items) || [];
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '没有要下载的条目' });
      const want = (req.body && req.body.quality) || (config && config.quality) || 'best';

      const id = `dl${Date.now()}${seq++}`;
      const outDir = defaultOutDir(config);
      fs.mkdirSync(outDir, { recursive: true });
      const job = { id, status: 'running', total: items.length, done: 0, files: [], errors: [], outDir };
      jobs.set(id, job);
      res.json({ ok: true, jobId: id, outDir });

      (async () => {
        // 整批共用一个抓取会话：打开一次，下载所有，最后关掉。
        // 播放地址绑会话（cookie），所以必须用会话内的 request 去拉。
        let bctx = null;
        try {
          try { bctx = await core.scraper.openSession(0); } catch (e) { log(`浏览器会话打开失败，退回裸 HTTP：${e.message}`); }

          for (const it of items) {
            try {
              // 选清晰度：优先 bitrateInfo 档位，否则回退 playAddr
              let url = '';
              const streams = Array.isArray(it.streams) ? it.streams : [];
              if (streams.length) {
                if (want === 'best') url = streams[0].url;
                else url = (streams.find((s) => s.quality === want) || streams[0]).url;
              }
              if (!url) url = it.playUrl;
              if (!url) throw new Error('没有可用的播放地址');

              const base = safeName(`${it.author ? it.author + '_' : ''}${it.desc || it.vid}`);
              let dest = path.join(outDir, `${base}_${it.vid}.mp4`);
              let n = 1;
              while (fs.existsSync(dest)) dest = path.join(outDir, `${base}_${it.vid}_${n++}.mp4`);

              const size = bctx
                ? await fetchViaBrowser(bctx, url, dest)
                : await fetchTo(url, dest, core.scraper.UA);
              job.done++;
              job.files.push({ vid: it.vid, file: dest, size, quality: want });
            } catch (e) {
              job.done++;
              job.errors.push({ vid: it.vid, error: e.message });
            }
          }
        } finally {
          if (bctx) { try { await bctx.close(); } catch (_) {} }
        }
        job.status = job.errors.length && !job.files.length ? 'error' : 'done';
      })();
    });

    /** 取播放地址（给内置播放器用）：优先公开解析服务，不启动浏览器 */
    app.post('/api/video-download/play-url', async (req, res) => {
      const url = String((req.body && req.body.url) || '');
      const vid = String((req.body && req.body.vid) || '');
      if (!url && !vid) return res.status(400).json({ error: '缺少 url 或 vid' });
      const target = url || `https://www.tiktok.com/@_/video/${vid}`;
      try {
        const it = await resolveViaTikwm(core, target);
        return res.json({ ok: true, playUrl: it.playUrl, cover: it.cover, duration: it.duration, desc: it.desc });
      } catch (e) {
        return res.status(500).json({ error: '取播放地址失败：' + e.message });
      }
    });

    app.get('/api/video-download/jobs/:id', (req, res) => {
      const j = jobs.get(req.params.id);
      if (!j) return res.status(404).json({ error: '任务不存在' });
      res.json(j);
    });

    /** 打开下载目录（Windows / macOS） */
    app.post('/api/video-download/open-dir', (req, res) => {
      const dir = defaultOutDir(config);
      try {
        const { exec } = require('child_process');
        if (process.platform === 'win32') exec(`explorer "${dir}"`);
        else if (process.platform === 'darwin') exec(`open "${dir}"`);
        else exec(`xdg-open "${dir}"`);
        res.json({ ok: true, dir });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    log('视频下载模块已挂载：/api/video-download/*');
  },
};

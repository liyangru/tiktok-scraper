/**
 * 模块：AI 分析与复刻脚本
 *
 * 数据源：lib/videodb.js（所有抓取过的视频，按 vid 去重 + 指标历史）。
 * 模型：free-llm-gateway（OpenAI 兼容，配置在 .env：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）。
 *
 * 三个能力：
 *   1. 单条视频 AI 解读（内容结构、情绪、hook、可复刻点）
 *   2. 品牌/账号级 AI 解读（基于数据库汇总数据）
 *   3. 复刻脚本：下载视频 → ffmpeg 抽帧 → 视觉模型读帧 → 产出可直接照做的脚本
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const AI_DIR_NAME = path.join('data', 'ai');

/** 找 ffmpeg：环境变量 → 打包资源 → 常见安装位置 → PATH */
function findFfmpeg(ctx) {
  const candidates = [
    process.env.FFMPEG_PATH,
    // Electron 打包态：extraResources 带的 bin/ffmpeg.exe（离线机器没有 PATH 里的 ffmpeg）
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'ffmpeg.exe') : null,
    path.join(ctx.baseDir, 'bin', 'ffmpeg.exe'),
    'C:/Users/18351/.workbuddy-ai/binaries/python/envs/default/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe',
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (_) {}
  }
  return null; // 没有就让 PATH 里的 ffmpeg 兜底（execFile('ffmpeg')）
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(-300)));
      resolve(stdout);
    });
  });
}

/** 下载视频（走抓取会话，播放地址绑定会话 cookie） */
async function downloadVideo(ctx, url, dest) {
  const bctx = await ctx.core.scraper.openSession(0);
  try {
    const resp = await bctx.request.get(url, { headers: { Referer: 'https://www.tiktok.com/' } });
    if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
    const buf = await resp.body();
    fs.writeFileSync(dest, buf);
    return buf.length;
  } finally {
    try { await bctx.close(); } catch (_) {}
  }
}

/** ffmpeg 均匀抽 N 帧 → base64 数组 */
async function extractFrames(ctx, video, n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttframes-'));
  const cmd = findFfmpeg(ctx) || 'ffmpeg';
  let dur = 0;
  try {
    const m = /Duration:\s*(\d+):(\d+):(\d+)/.exec(await run(cmd, ['-i', video]));
    if (m) dur = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch (_) {}
  const fps = dur > 0 ? (n / Math.max(dur, 1)).toFixed(4) : '0.5';
  await run(cmd, ['-i', video, '-vf', 'fps=' + fps + ',scale=480:-2', '-frames:v', String(n), '-q:v', '5', path.join(dir, 'f%02d.jpg')]);
  const frames = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
  return {
    dir,
    frames: frames.map((f) => fs.readFileSync(path.join(dir, f)).toString('base64')),
  };
}

module.exports = {
  register(app, ctx) {
    const { core, log } = ctx;
    const AI_DIR = ensureAiDir(ctx);
    function ensureAiDir(c) {
      const d = path.join(c.baseDir, AI_DIR_NAME);
      fs.mkdirSync(d, { recursive: true });
      return d;
    }

    const readDbVideo = (vid) => ctx.core.videodb.load().videos[String(vid)];
    const findRow = (vid) => {
      // 在最近的任务里找该视频的完整行（含 playUrl）
      const files = fs.readdirSync(ctx.dataDir).filter((f) => f.endsWith('.json'));
      for (const f of files.slice().reverse()) {
        try {
          const job = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, f), 'utf8'));
          const rows = core.report.toRows(job.results || []);
          const hit = rows.find((r) => String(r.vid) === String(vid));
          if (hit) return hit;
        } catch (_) {}
      }
      return null;
    };

    /** 1. 单条视频 AI 解读 */
    app.post('/api/ai-analyst/video', async (req, res) => {
      const vid = String((req.body && req.body.vid) || '');
      const v = readDbVideo(vid);
      if (!v) return res.status(404).json({ error: `视频库里没有 ${vid}` });
      const h = v.history || [];
      try {
        const out = await core.llm.chat([
          { role: 'system', content: '你是短视频内容与电商运营专家。用简体中文，输出紧凑的 Markdown，不要空话套话。' },
          {
            role: 'user',
            content: `分析这条 TikTok 视频（数据来自本机视频库）：
账号：@${v.account}
文案：${v.desc || '(无)'}
话题：${v.tags || '(无)'}
时长：${v.duration}s
指标：播放 ${v.latest.views}，赞 ${v.latest.likes}，评 ${v.latest.comments}，分享 ${v.latest.shares}，收藏 ${v.latest.saves}
${h.length > 1 ? `历史快照（看增长）：\n${h.map((x) => `${x.date}: 播放${x.views} 赞${x.likes}`).join('\n')}` : ''}

请输出（Markdown，每节 1-3 行，总长不超过 300 字）：
### 一句话判断
### 数据解读（互动结构与异常）
### 内容可复刻点（如果让你翻拍，抄哪三件事）
### 下一步建议`,
          },
        ]);
        const file = path.join(AI_DIR, `video-${vid}.md`);
        fs.writeFileSync(file, out);
        res.json({ ok: true, vid, analysis: out, file });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    /** 2. 品牌/账号级 AI 解读（复用 brand-analytics 的计算结果） */
    app.post('/api/ai-analyst/brand', async (req, res) => {
      const jobId = req.body && req.body.jobId;
      if (!jobId) return res.status(400).json({ error: '缺少 jobId' });
      const job = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, `${jobId}.json`), 'utf8'));
      const rows = core.report.toRows(job.results || []);
      const accounts = job.results || [];
      const agg = rows.length ? core.report.agg(rows) : null;
      const perAcc = accounts.map((a) => ({
        handle: a.handle,
        followers: Number(a.stats && a.stats.followerCount) || 0,
        videos: (a.items || []).length,
        views: (a.items || []).reduce((t, x) => t + (Number(x.statsV2 && x.statsV2.playCount) || 0), 0),
      }));
      const top = [...rows].sort((a, b) => b.views - a.views).slice(0, 8);
      try {
        const out = await core.llm.chat([
          { role: 'system', content: '你是新媒体运营与电商数据分析专家。用简体中文，Markdown，直接给结论和动作，不要铺垫。' },
          {
            role: 'user',
            content: `这是本机视频库的一批 TikTok 数据，请做运营解读：
账号：${perAcc.map((a) => `@${a.handle}(粉丝${a.followers}, ${a.videos}条, 播放${a.views})`).join('；')}
整体：${rows.length} 条视频，总播放 ${rows.reduce((t, r) => t + r.views, 0)}，平均互动率 ${(agg.inter * 100).toFixed(2)}%，平均时长 ${agg.avgDuration}s，挂车 ${agg.ecN} 条
TOP 视频：${top.map((r) => `@${r.account}「${(r.desc || '').slice(0, 24)}」${r.views}播放`).join('；')}

输出（Markdown，总长 ≤400 字）：
### 账号结构判断（谁在扛量、为什么）
### 内容规律（从 TOP 里能看出的共同点：主题/时长/挂车）
### 三条立刻可执行的动作`,
          },
        ]);
        const file = path.join(AI_DIR, `brand-${jobId}.md`);
        fs.writeFileSync(file, out);
        res.json({ ok: true, jobId, analysis: out, file });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    /** 3. 复刻脚本：抽帧 + 视觉模型 */
    app.post('/api/ai-analyst/remake', async (req, res) => {
      const vid = String((req.body && req.body.vid) || '');
      const v = readDbVideo(vid);
      if (!v) return res.status(404).json({ error: `视频库里没有 ${vid}` });
      const row = findRow(vid);
      const playUrl = (row && row.playUrl) || v.playUrl;
      if (!playUrl) return res.status(400).json({ error: '这条视频没有可用的播放地址（列表接口没下发，也未在详情页补到）' });

      try {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ttremake-'));
        const video = path.join(tmp, 'v.mp4');
        log(`复刻脚本：下载视频 ${vid}…`);
        await downloadVideo(ctx, playUrl, video);
        log('抽帧…');
        const { frames, dir } = await extractFrames(ctx, video, 8);
        if (!frames.length) throw new Error('抽帧失败（ffmpeg 缺失？设 FFMPEG_PATH 环境变量）');

        log('视觉模型读帧…');
        const out = await core.llm.chatVision(
          `这是一条 TikTok 视频按时间均匀抽取的 ${frames.length} 帧（账号 @${v.account}，文案：${v.desc}，${v.duration}s，播放 ${v.latest.views}）。
请像编导一样拆解并输出「复刻脚本」，简体中文 Markdown，结构：
### 开头 3 秒 hook（原文大意 + 为什么有效）
### 分镜脚本（表：时间 | 画面内容 | 口播/字幕 | 运镜）
### 文案与话题标签（可直接抄的模板）
### 音乐与节奏
### 拍摄清单（需要准备什么道具/场景）
### 发布建议（时间、封面、标题写法）
控制在 600 字内，宁可具体不要空话。`,
          frames
        );
        const file = path.join(AI_DIR, `remake-${vid}.md`);
        fs.writeFileSync(file, out);
        try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
        res.json({ ok: true, vid, frames: frames.length, script: out, file });
      } catch (e) {
        // 用户报告过「生成复刻脚本不能用」但看不到原因 —— 失败必须给可行动的提示
        const msg = String(e && e.message || e);
        let hint = msg;
        if (/ffmpeg|抽帧/.test(msg)) hint = '抽帧失败：缺少 ffmpeg。已随应用内置，若仍报错请把 FFMPEG_PATH 指向 ffmpeg.exe。' + msg;
        else if (/LLM|AI 未配置/.test(msg)) hint = 'AI 接口未配置或调用失败：请在 设置 → 大模型接口 里填好 Base URL / API Key（视觉模型建议单独配 LLM_VISION_MODEL）。' + msg;
        else if (/HTTP 4\d\d/.test(msg)) hint = '视频下载被拒（' + msg + '），播放地址可能已过期 —— 重新抓一次该账号后再试。';
        res.status(500).json({ error: hint });
      }
    });

    /** 该模块需要的历史视频列表（给前端选择） */
    app.get('/api/ai-analyst/videos', (req, res) => {
      const db = ctx.core.videodb.load();
      const list = Object.values(db.videos)
        .sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''))
        .slice(0, 200)
        .map((v) => ({ vid: v.vid, account: v.account, desc: v.desc, views: v.latest.views, duration: v.duration, hasPlay: !!v.playUrl }));
      res.json({ videos: list, db: ctx.core.videodb.stats() });
    });

    log('AI 分析模块已挂载：/api/ai-analyst/*');
  },
};

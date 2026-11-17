/**
 * 模块：AI 分析与复刻脚本
 *
 * 数据源：lib/videodb.js（所有抓取过的视频，按 vid 去重 + 指标历史）。
 * 模型：free-llm-gateway（OpenAI 兼容，配置在 .env：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）。
 *
 * 三个能力：
 *   1. 单条视频 AI 解读（内容结构、情绪、hook、可复刻点）
 *   2. 品牌/账号级 AI 解读（基于数据库汇总数据）
 */
const fs = require('fs');
const path = require('path');

const AI_DIR_NAME = path.join('data', 'ai');

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

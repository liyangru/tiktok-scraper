/**
 * 内置功能：单条视频 AI 分析
 *
 * 数据源：lib/videodb.js（所有抓取过的视频，按 vid 去重 + 指标历史）。
 * 模型：OpenAI 兼容网关（配置在 .env：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）。
 * 结果另存一份到 <BASE_DIR>/data/ai/video-<vid>.md，方便事后翻看。
 */
const fs = require('fs');
const path = require('path');

module.exports = {
  register(app, ctx) {
    const { core, log } = ctx;
    const AI_DIR = path.join(ctx.baseDir, 'data', 'ai');
    fs.mkdirSync(AI_DIR, { recursive: true });
    const readDbVideo = (vid) => core.videodb.load().videos[String(vid)];

    /** 1. 单条视频 AI 分析 */
    app.post('/api/ai/video', async (req, res) => {
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
### 内容可借鉴点（最值得保留的三件事）
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

    log('AI 单条视频分析已挂载：/api/ai/video');
  },
};

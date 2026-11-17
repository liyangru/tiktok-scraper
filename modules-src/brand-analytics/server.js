/**
 * 模块：品牌媒体分析
 *
 * 多个账号属于同一品牌时，看品牌整体而不是单账号。
 * 分组存在模块自己的配置里（settings.json 的 modules['brand-analytics'].config.groups）。
 */
const fs = require('fs');
const path = require('path');

module.exports = {
  register(app, ctx) {
    const { core, config, log } = ctx;

    // ⚠️ 每次现读，不能用注册时的 ctx.config（保存分组后那份是旧的）
    const getGroups = () => (ctx.settings.getConfig('brand-analytics').groups) || [];

    app.get('/api/brand-analytics/groups', (req, res) => res.json({ groups: getGroups() }));

    app.post('/api/brand-analytics/groups', (req, res) => {
      const g = req.body && req.body.groups;
      if (!Array.isArray(g)) return res.status(400).json({ error: 'groups 必须是数组' });
      const clean = g
        .map((x) => ({
          name: String(x.name || '').trim(),
          handles: (x.handles || []).map((h) => String(h).replace(/^@/, '').trim()).filter(Boolean),
        }))
        .filter((x) => x.name && x.handles.length);
      ctx.settings.setConfig('brand-analytics', { groups: clean });
      res.json({ ok: true, groups: clean });
    });

    /**
     * 品牌级分析。
     * body: { jobId, from?, to?, groups? }  —— groups 不传就用已保存的分组
     */
    app.post('/api/brand-analytics/analyze', (req, res) => {
      const jobId = req.body && req.body.jobId;
      if (!jobId) return res.status(400).json({ error: '缺少 jobId' });
      const jobPath = path.join(ctx.dataDir, `${jobId}.json`);
      if (!fs.existsSync(jobPath)) return res.status(404).json({ error: `找不到任务 ${jobId}` });
      const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));

      const rows = core.report.toRows(job.results || []);
      const accounts = job.results || [];
      const from = req.body && req.body.from;
      const to = req.body && req.body.to;
      const inRange = (r) => (!from || r.date >= from) && (!to || r.date <= to);
      const rrows = rows.filter(inRange);

      const saved = getGroups();
      const groups = (req.body && Array.isArray(req.body.groups) && req.body.groups.length ? req.body.groups : saved);
      if (!groups.length) {
        return res.status(400).json({ error: '还没有分组。先把账号归类到品牌里。' });
      }

      const groupedHandles = new Set(groups.flatMap((g) => g.handles));
      const allHandles = [...new Set(rows.map((r) => r.account))];
      const ungrouped = allHandles.filter((h) => !groupedHandles.has(h));

      const brands = groups.map((g) => {
        const rows2 = rrows.filter((r) => g.handles.includes(r.account));
        const accs = accounts.filter((a) => g.handles.includes(a.handle));
        const fans = accs.reduce((t, a) => t + (Number(a.stats && a.stats.followerCount) || 0), 0);
        const a = core.report.agg(rows2);

        // 账号贡献对比
        const perAccount = g.handles
          .map((h) => {
            const rs = rows2.filter((r) => r.account === h);
            const aa = core.report.agg(rs);
            const acc = accs.find((x) => x.handle === h);
            return {
              handle: h,
              followers: acc ? Number(acc.stats && acc.stats.followerCount) || 0 : 0,
              n: aa.n,
              tv: aa.tv,
              avg: aa.avg,
              med: aa.med,
              max: aa.max,
              saves: aa.saves,
              reposts: aa.reposts,
              inter: aa.inter,
              avgDuration: aa.avgDuration,
              viewShare: a.tv ? aa.tv / a.tv : 0,
            };
          })
          .sort((x, y) => y.tv - x.tv);
        // 贡献占比（相对品牌总播放）
        perAccount.forEach((x) => (x.viewShare = a.tv ? x.tv / a.tv : 0));

        // 月度趋势
        const months = {};
        for (const r of rows2) {
          const m = months[r.month] || (months[r.month] = { month: r.month, count: 0, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, reposts: 0 });
          m.count++;
          m.views += r.views;
          m.likes += r.likes;
          m.comments += r.comments;
          m.shares += r.shares;
          m.saves += r.saves;
          m.reposts += r.reposts;
        }
        const trend = Object.values(months).sort((x, y) => x.month.localeCompare(y.month));

        // 品牌 TOP 视频榜
        const top = [...rows2]
          .sort((x, y) => y.views - x.views)
          .slice(0, 20)
          .map((r) => ({
            account: r.account,
            date: r.date,
            desc: r.desc,
            views: r.views,
            likes: r.likes,
            comments: r.comments,
            shares: r.shares,
            saves: r.saves,
            duration: r.duration,
            isEC: r.isEC,
            url: r.url,
          }));

        return {
          name: g.name,
          handles: g.handles,
          fans,
          n: a.n,
          tv: a.tv,
          avg: a.avg,
          med: a.med,
          max: a.max,
          likes: a.likes,
          comments: a.comments,
          shares: a.shares,
          saves: a.saves,
          reposts: a.reposts,
          inter: a.inter,
          avgDuration: a.avgDuration,
          avgLikes: a.avgLikes,
          avgComments: a.avgComments,
          avgShares: a.avgShares,
          avgSaves: a.avgSaves,
          ecN: a.ecN,
          perAccount,
          trend,
          top,
        };
      });

      // 品牌之间横向对比（多个品牌时看谁是主力）
      const tvSum = brands.reduce((t, b) => t + b.tv, 0);
      brands.forEach((b) => (b.viewShare = tvSum ? b.tv / tvSum : 0));

      res.json({
        ok: true,
        jobId,
        dateRange: { from: from || '', to: to || '' },
        brands,
        ungrouped,
        totalRows: rrows.length,
      });
    });

    log('品牌媒体分析模块已挂载：/api/brand-analytics/*');
  },
};

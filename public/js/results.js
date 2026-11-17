/* ============================================================
   结果区：概览 → 图表 → 挂车对比 → 周期对比（明细表在 table.js）

   口径全部来自 public/shared/metrics.js（与导出 / 命令行 / 插件共用）：
   - 概览、图表、挂车对比只统计「本期」；周期对比同时看两期
   - 改日期 / 对比方式：新区间仍在这次抓取的范围内 → 直接用真实视频重算；超出 → 提示重新抓取
   - 说明文字一律收进 ⓘ，界面只留数字
   ============================================================ */
const TTResults = (() => {
  let creatorCache = null;
  const aiCache = new Map();

  /* ---------------- 期次与覆盖范围 ---------------- */
  function viewFromJob(job) {
    return {
      currentFrom: job.currentFrom,
      currentTo: job.currentTo,
      compareFrom: job.compareFrom || null,
      compareTo: job.compareTo || null,
      mode: job.compareMode || (job.compareFrom ? 'custom' : 'none'),
      info: job.compareInfo || null,
    };
  }
  const sameView = (a, b) =>
    !!a && !!b && a.currentFrom === b.currentFrom && a.currentTo === b.currentTo && a.compareFrom === b.compareFrom && a.compareTo === b.compareTo;

  function reclassify(view) {
    for (const r of state.rows) {
      if (r.fromLink || !r.date) continue;
      const c = TTPeriod.classify(r.date, view);
      r.inCurrent = c.inCurrent;
      r.inCompare = c.inCompare;
      r.period = c.period;
    }
  }
  function coverageGaps(view, accts) {
    const job = state.job;
    if (!job || !view) return [];
    const need = view.compareFrom && view.compareFrom < view.currentFrom ? view.compareFrom : view.currentFrom;
    return (job.coverage || []).filter((c) => !c.error && (!accts || accts.includes(c.handle)) && c.from > need);
  }
  function covered(view) {
    const job = state.job;
    if (!job) return false;
    const lo = view.compareFrom && view.compareFrom < view.currentFrom ? view.compareFrom : view.currentFrom;
    const hi = view.compareTo && view.compareTo > view.currentTo ? view.compareTo : view.currentTo;
    return lo >= job.from && hi <= job.to;
  }

  const accounts = () => [...new Set(state.rows.filter((r) => !r.fromLink).map((r) => r.account))];
  const selectedRows = () => state.rows.filter((r) => !r.fromLink && (state.account === '__all__' || r.account === state.account));
  const selectedAccounts = () => (state.account === '__all__' ? (state.job && state.job.handles) || accounts() : [state.account]);

  /** 本期起点：「全部」模式下用实际最早的发布日，避免从 2016 年画起 */
  function effFrom(rows) {
    const v = state.view;
    if (!TTPeriod.isAll(v.currentFrom)) return v.currentFrom;
    return rows.reduce((m, r) => (r.date && r.date < m ? r.date : m), v.currentTo);
  }

  /* ---------------- 按发布日汇总的序列 ----------------
     「播放」= 当天发布的视频截至抓取时的累计播放；当天没发 → 没有数据（断线），发布数则是真实的 0。
     超过 120 天按周汇总。 */
  function series(rows, from, to, metric) {
    if (!from || !to) return { points: [], weekly: false };
    const weekly = TTPeriod.span(from, to) > 120;
    const keyOf = (d) => (weekly ? TTPeriod.weekStart(d) : d);
    const buckets = new Map();
    for (let c = weekly ? TTPeriod.weekStart(from) : from; c <= to; c = TTPeriod.addDays(c, weekly ? 7 : 1)) buckets.set(c, { n: 0, views: 0, inter: 0 });
    for (const r of rows) {
      if (!r.date || r.date < from || r.date > to || !isNum(r.views)) continue;
      const b = buckets.get(keyOf(r.date));
      if (!b) continue;
      b.n++;
      b.views += r.views;
      b.inter += TTMetrics.interactionsOf(r);
    }
    const points = [...buckets.entries()].map(([d, b]) => ({
      x: shortDate(d),
      label: weekly ? `${d} ~ ${TTPeriod.addDays(d, 6)}` : d,
      v: metric === 'posts' ? b.n : metric === 'inter' ? (b.views > 0 ? b.inter / b.views : null) : b.n ? b.views : null,
      note: b.n ? t('postsN', { n: b.n }) : t('noPostsDay'),
    }));
    return { points, weekly };
  }

  /* ---------------- 顶部 ---------------- */
  function renderHead() {
    const v = state.view;
    const job = state.job;
    let html = `<b>${esc(rangeText(v.currentFrom, v.currentTo))}</b> ${esc(t('nDays', { n: TTPeriod.span(v.currentFrom, v.currentTo) }))}`;
    if (v.compareFrom) html += ` <span>vs</span> <b>${esc(rangeText(v.compareFrom, v.compareTo))}</b> <span class="tag">${esc(t('cmpMode_' + (v.mode || 'custom')))}</span>`;
    const diff = job && !sameView(v, viewFromJob(job));
    if (diff) html += tipHtml(t('exportUsesJob', { range: rangeText(job.currentFrom, job.currentTo) }));
    $('#resultMeta').innerHTML = html;

    const accs = accounts();
    const tabs = $('#acctTabs');
    tabs.hidden = accs.length < 2;
    tabs.innerHTML =
      accs.length < 2
        ? ''
        : [['__all__', t('allAccounts')], ...accs.map((a) => [a, '@' + a])]
            .map(([k, label]) => `<button type="button" role="radio" data-acct="${esc(k)}" aria-checked="${state.account === k}" class="${state.account === k ? 'on' : ''}">${esc(label)}</button>`)
            .join('');
    const dis = state.busy || !job || !state.rows.length;
    $('#exportXlsx').disabled = $('#exportCsv').disabled = $('#copyBrief').disabled = dis;
  }

  /* ---------------- 数据提示（一行，详情在 ⓘ） ---------------- */
  function renderBanner() {
    const host = $('#dataBanner');
    const msgs = [];
    if (state.mismatch) {
      msgs.push(
        `<div class="notice warn"><span>${esc(t('mismatchTitle'))} ${tipHtml(t('mismatchBody', { have: rangeText(state.job.from, state.job.to), want: rangeText(state.mismatch.lo, state.mismatch.hi) }))}</span><button type="button" class="xs primary" data-rescrape>${esc(t('rescrape'))}</button></div>`
      );
    }
    const gaps = coverageGaps(state.view, selectedAccounts());
    if (gaps.length) msgs.push(`<div class="notice warn"><span>${esc(t('gapTitle'))} ${tipHtml(t('gapBody', { list: gaps.map((g) => `@${g.handle} ≥ ${g.from}`).join('，') }))}</span></div>`);
    const failed = ((state.job && state.job.coverage) || []).filter((c) => c.error);
    if (failed.length) msgs.push(`<div class="notice err"><span>${esc(t('failedAccTitle'))} ${tipHtml(failed.map((c) => `@${c.handle}：${c.error}`).join('\n'))}</span></div>`);
    host.innerHTML = msgs.join('');
    host.hidden = !msgs.length;
  }

  /* ---------------- KPI（不折叠：核心数据一眼可见） ---------------- */
  /* 主指标 4 个大卡，次要指标收进一条横条：层级清楚，不再 9 张卡排成参差的两行 */
  const KPIS = [
    { key: 'videos', label: 'kpiVideos', get: (a) => a.n, kind: 'int', total: true, main: true },
    { key: 'views', label: 'kpiViews', get: (a) => a.views, kind: 'int', total: true, main: true },
    { key: 'avgViews', label: 'kpiAvgViews', get: (a) => a.avgViews, kind: 'int', main: true },
    { key: 'inter', label: 'colEngage', get: (a) => a.inter, kind: 'pct', hint: 'kpiInterHint', main: true },
    { key: 'likes', label: 'colLikes', get: (a) => a.likes, kind: 'int', total: true },
    { key: 'comments', label: 'colComments', get: (a) => a.comments, kind: 'int', total: true },
    { key: 'shares', label: 'colShares', get: (a) => a.shares, kind: 'int', total: true },
    { key: 'saves', label: 'colSaves', get: (a) => a.saves, kind: 'int', total: true },
    { key: 'ecShare', label: 'kpiEcShare', get: (a) => a.ecShare, kind: 'pct' },
  ];

  function compareContext(rows) {
    const v = state.view;
    if (!v.compareFrom) return null;
    const gaps = coverageGaps(v, selectedAccounts()).filter((g) => g.from > v.compareFrom);
    return { pc: TTMetrics.periodCompare(rows, v), insufficient: gaps.length > 0, gaps };
  }

  /** 比率类指标的差值用「百分点」，其它用相对变化率 */
  function ppChip(abs, title) {
    if (!isNum(abs)) return deltaChip(null);
    const cls = abs > 0.00005 ? 'up' : abs < -0.00005 ? 'down' : 'flat';
    return `<span class="delta ${cls}"${title ? ` title="${esc(title)}"` : ''}>${cls === 'up' ? '▲' : cls === 'down' ? '▼' : ''}${Math.abs(abs * 100).toFixed(2)}${esc(t('ppShort'))}</span>`;
  }

  function renderKpis(rows, ctx) {
    const cur = TTMetrics.aggregate(rows.filter(TTMetrics.inCurrent));
    const cmp = ctx ? TTMetrics.aggregate(rows.filter(TTMetrics.inCompare)) : null;
    const curDays = TTPeriod.span(state.view.currentFrom, state.view.currentTo);
    const cmpDays = ctx ? TTPeriod.span(state.view.compareFrom, state.view.compareTo) : 0;
    const same = curDays === cmpDays;
    const cell = (k) => {
      const val = k.get(cur);
      let foot = '';
      if (k.key === 'ecShare') foot = `<span>${esc(t('ecOfN', { a: cur.ecN, n: cur.n }))}</span>`;
      // 对比数据不足时卡片上不显示变化（顶部已统一提示一次，不在每张卡上重复）
      if (ctx && !ctx.insufficient) {
        let a = val, b = k.get(cmp);
        const perDay = k.total && !same;
        if (perDay) {
          a = isNum(a) ? a / curDays : null;
          b = isNum(b) ? b / cmpDays : null;
        }
        const title = `${t('pcCmp')} ${fmtKind(k.get(cmp), k.kind)}${perDay ? ` · ${t('vsCmpPerDay')}` : ''}`;
        foot += k.kind === 'pct' ? ppChip(TTMetrics.delta(a, b).abs, title) : deltaChip(TTMetrics.delta(a, b).pct, { title });
      } else if (k.key === 'avgViews' && isNum(cur.medViews)) foot = `<span>${esc(t('medianX', { v: fmtCompact(cur.medViews) }))}</span>`;
      return `<div class="kpi"><div class="k">${esc(t(k.label))}${k.hint ? tipHtml(t(k.hint)) : ''}</div><div class="v">${esc(fmtKind(val, k.kind))}</div><div class="f">${foot}</div></div>`;
    };
    $('#kpis').innerHTML =
      `<div class="kpi-main">${KPIS.filter((k) => k.main).map(cell).join('')}</div>` +
      `<div class="kpi-strip">${KPIS.filter((k) => !k.main).map(cell).join('')}</div>`;
  }

  /* ---------------- 账号卡片（数据常显，迷你趋势可折叠） ---------------- */
  function renderAccounts() {
    const host = $('#accountCards');
    const accs = accounts();
    const summary = (state.job && state.job.summary) || [];
    if (accs.length < 2) {
      host.innerHTML = '';
      return;
    }
    host.innerHTML = `<div class="acct-grid">${accs
      .map((h) => {
        const rows = state.rows.filter((r) => !r.fromLink && r.account === h && TTMetrics.inCurrent(r));
        const a = TTMetrics.aggregate(rows);
        const s = summary.find((x) => x.handle === h) || {};
        const fans = s.stats && s.stats.followerCount;
        const ser = series(rows, effFrom(rows), state.view.currentTo, 'views');
        const peak = ser.points.reduce((m, p) => (isNum(p.v) && (!m || p.v > m.v) ? p : m), null);
        return `<div class="acct-card${state.account === h ? ' sel' : ''}">
          <div class="ac-head"><b>@${esc(h)}</b><span>${esc(s.nickname || '')}</span>
            <button type="button" class="icon-btn" data-dl-handle="${esc(h)}" title="${esc(t('cardDownload'))}" aria-label="${esc(t('cardDownload'))}">⤓</button></div>
          <div class="ac-stats">
            <div><span>${esc(t('followers'))}</span><b>${isNum(fans) ? fmtCompact(fans) : DASH}</b></div>
            <div><span>${esc(t('kpiVideos'))}</span><b>${fmtInt(a.n)}</b></div>
            <div><span>${esc(t('kpiViews'))}</span><b>${fmtCompact(a.views)}</b></div>
            <div><span>${esc(t('kpiAvgViews'))}</span><b>${a.n ? fmtCompact(a.avgViews) : DASH}</b></div>
            <div><span>${esc(t('colEngage'))}</span><b>${fmtPct(a.inter)}</b></div>
            <div><span>${esc(t('kpiEcShare'))}</span><b>${fmtPct(a.ecShare, 0)}</b></div>
          </div>
          ${TTCollapse.html({
            id: 'acct:' + h,
            variant: 'item',
            title: esc(t('acctTrend')),
            summary: peak ? `${esc(t('peak'))} <b>${esc(peak.x)}</b> ${esc(fmtCompact(peak.v))}` : '',
            body: TTChart.placeholder({ series: [{ name: '@' + h, points: ser.points }], compact: true, kind: 'int', empty: t('chartEmptyPosts') }),
          })}
        </div>`;
      })
      .join('')}</div>`;
  }

  /* ---------------- 发布与播放趋势 ---------------- */
  const DAILY_METRICS = [
    { key: 'views', label: 'colViews', unit: 'unitViews', kind: 'int' },
    { key: 'posts', label: 'metricPosts', unit: 'unitPosts', kind: 'int' },
    { key: 'inter', label: 'colEngage', unit: 'unitInter', kind: 'pct' },
  ];
  function renderDaily(rows, ctx) {
    const v = state.view;
    const metric = DAILY_METRICS.find((m) => m.key === prefs.get('dailyMetric', 'views')) || DAILY_METRICS[0];
    const curRows = rows.filter(TTMetrics.inCurrent);
    const from = effFrom(curRows);
    const cur = series(curRows, from, v.currentTo, metric.key);
    const ser = [{ name: t('pcCur'), tone: 'cur', points: cur.points }];
    if (ctx && !ctx.insufficient) {
      // 对比期按「第 N 天」与本期对齐叠加；提示框里显示对比期的真实日期
      const cmp = series(rows.filter(TTMetrics.inCompare), v.compareFrom, v.compareTo, metric.key);
      ser.push({ name: t('pcCmp'), tone: 'cmp', dashed: true, points: cmp.points.map((p, i) => ({ ...p, x: cur.points[i] ? cur.points[i].x : p.x })) });
    }
    const vals = cur.points.filter((p) => isNum(p.v));
    const peak = vals.reduce((m, p) => (!m || p.v > m.v ? p : m), null);
    const summary =
      metric.key === 'posts'
        ? `<b>${fmtInt(curRows.length)}</b> · ${esc(t('activeDays', { n: vals.filter((p) => p.v > 0).length }))}`
        : peak ? `${esc(t('peak'))} <b>${esc(peak.x)}</b> ${esc(metric.kind === 'pct' ? fmtPct(peak.v) : fmtCompact(peak.v))}` : '';
    $('#chartDaily').innerHTML = TTCollapse.html({
      id: 'chart:daily',
      title: esc(t('dailyTitle')),
      meta: esc((cur.weekly ? t('dailyMetaWeekly') + '\n' : '') + (metric.key === 'posts' ? t('dailyPostsNote') : t('dailyNote'))),
      summary,
      extra: `<div class="tabs sm" role="radiogroup">${DAILY_METRICS.map((m) => `<button type="button" role="radio" data-daily="${m.key}" aria-checked="${m === metric}" class="${m === metric ? 'on' : ''}">${esc(t(m.label))}</button>`).join('')}</div>`,
      body: TTChart.placeholder({ series: ser, unit: t(metric.unit), kind: metric.kind, empty: t('chartEmptyPosts'), aria: t('dailyTitle') }),
    });
  }

  /* ---------------- 发布时段（条均播放 by 小时） ----------------
     每个小时：发了几条、条均播放。只发过 1 条的时段不参与「最佳」评选，避免一条爆款误导。 */
  function hourStats(rows) {
    const h = Array.from({ length: 24 }, (_, i) => ({ hour: i, n: 0, views: 0 }));
    for (const r of rows) {
      const k = Number(String(r.time || '').slice(0, 2));
      if (!Number.isFinite(k) || k < 0 || k > 23 || !isNum(r.views)) continue;
      h[k].n++;
      h[k].views += r.views;
    }
    h.forEach((x) => (x.avg = x.n ? x.views / x.n : null));
    const ranked = h.filter((x) => x.n >= 2).sort((a, b) => b.avg - a.avg);
    return { hours: h, best: ranked.slice(0, 3).map((x) => x.hour) };
  }
  function renderHours(rows) {
    const cur = rows.filter(TTMetrics.inCurrent);
    const { hours, best } = hourStats(cur);
    const max = Math.max(0, ...hours.map((x) => x.avg || 0));
    const pad = (n) => String(n).padStart(2, '0');
    const summary = best.length ? `${esc(t('bestHours'))} <b>${best.map((h) => pad(h) + ':00').join(' / ')}</b>` : `<span>${esc(t('hoursFew'))}</span>`;
    $('#chartHours').innerHTML = TTCollapse.html({
      id: 'chart:hours',
      title: esc(t('hoursTitle')),
      meta: esc(t('hoursNote')),
      summary,
      body: cur.length
        ? `<div class="hours" role="img" aria-label="${esc(t('hoursTitle'))}">${hours
            .map((x) => {
              const h = x.avg && max ? Math.max(2, (x.avg / max) * 100) : 0;
              const cls = !x.n ? 'none' : best.includes(x.hour) ? 'best' : '';
              const title = x.n ? `${pad(x.hour)}:00 · ${t('postsN', { n: x.n })} · ${t('kpiAvgViews')} ${fmtInt(x.avg)}` : `${pad(x.hour)}:00 · ${t('noPostsDay')}`;
              return `<div class="hb ${cls}" title="${esc(title)}"><i style="height:${x.n ? h.toFixed(1) : 100}%"></i></div>`;
            })
            .join('')}</div><div class="hours-x">${hours.map((x) => `<span>${x.hour % 3 === 0 ? pad(x.hour) : ''}</span>`).join('')}</div>`
        : `<div class="chart-empty">${esc(t('chartEmptyPosts'))}</div>`,
    });
  }

  /* ---------------- 创作中心趋势 ---------------- */
  const CR_METRICS = [
    { key: 'vv_history', label: 'colViews', unit: 'unitViews' },
    { key: 'like_history', label: 'colLikes', unit: 'unitCount' },
    { key: 'comment_history', label: 'colComments', unit: 'unitCount' },
    { key: 'share_history', label: 'colShares', unit: 'unitCount' },
    { key: 'follower_num_history', label: 'followers', unit: 'unitPeople' },
    { key: 'net_follower_history', label: 'crNetFans', unit: 'unitPeople' },
    { key: 'video_finish_rate_history_7d', label: 'sfFinish', unit: 'unitPct', pct: true },
    { key: 'reached_audience_history', label: 'crReach', unit: 'unitPeople' },
    { key: 'pv_history', label: 'crProfileViews', unit: 'unitCount' },
  ];
  const CR_TRAFFIC = { Search: 'crSrcSearch', 'Personal Profile': 'crSrcProfile', Follow: 'crSrcFollow', 'For You': 'crSrcForYou', Sound: 'crSrcSound' };
  async function loadCreator(force) {
    if (creatorCache && !force && Date.now() - creatorCache.t < 60000) return creatorCache.d;
    let d = null;
    try {
      d = await fetch(API + '/api/tiktok-login/insight', { cache: 'no-store' }).then((x) => x.json());
    } catch (_) {}
    creatorCache = { t: Date.now(), d };
    return d;
  }
  async function renderCreator(force) {
    const host = $('#chartCreator');
    const d = await loadCreator(force);
    const s = (d && d.series) || {};
    if (!d || !d.ok || !Object.keys(s).length) {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const meta = d.meta || {};
    const items = CR_METRICS.filter((m) => Array.isArray(s[m.key]) && s[m.key].length).map((m) => {
      let vals = s[m.key].map((x) => (x === null || x === '' ? null : Number(x))).map((x) => (Number.isFinite(x) ? x : null));
      const real = vals.filter(isNum);
      if (m.pct && real.length && Math.max(...real) > 1) vals = vals.map((x) => (isNum(x) ? x / 100 : x));
      const n = vals.length;
      // 创作中心只给按天排列的序列、不带日期：横轴如实写「距最新 N 天」，不去猜日期
      const pts = vals.map((v, i) => ({ x: i === n - 1 ? t('latest') : `-${n - 1 - i}${t('dayShort')}`, label: i === n - 1 ? t('latest') : t('daysAgo', { n: n - 1 - i }), v }));
      const r2 = vals.filter(isNum);
      const first = r2[0], last = r2[r2.length - 1];
      return TTCollapse.html({
        id: 'creator:' + m.key,
        variant: 'item',
        title: esc(t(m.label)),
        summary: r2.length >= 2 ? `<b>${esc(m.pct ? fmtPct(last, 1) : fmtCompact(last))}</b> ${deltaChip(TTMetrics.delta(last, first).pct)}` : `<span>${esc(t('chartSinglePointShort'))}</span>`,
        body: TTChart.placeholder({ series: [{ name: t(m.label), points: pts }], unit: t(m.unit), kind: m.pct ? 'pct' : 'int', height: 150 }),
      });
    });
    const traffic = Array.isArray(meta.traffic) ? meta.traffic.slice(0, 6) : [];
    const upd = d.at ? new Date(Date.parse(d.at) + 7 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
    host.innerHTML = TTCollapse.html({
      id: 'chart:creator',
      title: esc(t('crTitle')),
      meta: esc([d.handle ? '@' + d.handle : '', upd ? t('crUpdated', { t: upd }) : ''].filter(Boolean).join('\n')),
      summary: meta.followers ? `${esc(t('followers'))} <b>${esc(fmtCompact(meta.followers))}</b>` : '',
      extra: `<button type="button" class="xs ghost" data-cr-refresh>${esc(t('crRefresh'))}</button>`,
      body:
        `<div class="cx-stack">${items.join('') || `<div class="chart-empty">${esc(t('crNoSeries'))}</div>`}</div>` +
        (traffic.length ? `<div class="sub-line" style="margin-top:10px">${esc(t('crTraffic'))} ${traffic.map((x) => `<span class="tag">${esc(CR_TRAFFIC[x.key] ? t(CR_TRAFFIC[x.key]) : x.key)} ${(Number(x.pct) || 0).toFixed(1)}%</span>`).join('')}</div>` : ''),
    });
    TTChart.mountAll(host);
  }

  /* ---------------- 挂车 vs 非挂车 ---------------- */
  const CART_LABEL = { views: 'cartAvgViews', likes: 'cartAvgLikes', comments: 'cartAvgComments', shares: 'cartAvgShares', saves: 'cartAvgSaves', inter: 'colEngage' };
  function renderCart(rows) {
    const mode = prefs.get('cartMode', 'mean');
    const cc = TTMetrics.cartCompare(rows.filter(TTMetrics.inCurrent), mode);
    const views = cc.metrics.find((m) => m.key === 'views');
    const summary =
      `<span>${esc(t('cartCounts', { a: cc.ec.n, b: cc.non.n }))}</span>` +
      (cc.ec.n && cc.non.n ? ` ${deltaChip(views.pct, { title: t('cartDeltaTip') })}` : '');
    const seg = `<div class="tabs sm" role="radiogroup">${TTMetrics.CART_MODES.map((m) => `<button type="button" role="radio" data-cart="${m}" aria-checked="${m === mode}" class="${m === mode ? 'on' : ''}">${esc(t('cartMode_' + m))}</button>`).join('')}</div>`;
    let body;
    if (!cc.ec.n || !cc.non.n) {
      body = `<div class="chart-empty">${esc(!cc.ec.n && !cc.non.n ? t('noData') : !cc.ec.n ? t('cartNoEc') : t('cartNoNon'))}</div>`;
    } else {
      const sample = (g) => (cc.mode === 'trim' && g.trimmed ? `${g.used}/${g.n}` : '');
      body =
        (cc.fallback.ec || cc.fallback.non
          ? `<div class="notice warn" style="margin-bottom:12px"><span>${esc(t('cartFallback', { group: [cc.fallback.ec ? t('ecYes') : '', cc.fallback.non ? t('ecNo') : ''].filter(Boolean).join(' / '), n: TTMetrics.TRIM_MIN_N }))}</span></div>`
          : '') +
        TTChart.pairBars(
          cc.metrics.map((m) => ({
            label: t(CART_LABEL[m.key]),
            a: m.ec.value,
            b: m.non.value,
            kind: m.kind,
            aNote: sample(m.ec),
            bNote: sample(m.non),
            delta: m.kind === 'pct' ? ppChip(m.abs) : deltaChip(m.pct, { title: `${t('diffAbs')} ${fmtSigned(m.abs, m.kind)}` }),
          })),
          { aName: `${t('ecYes')} ${cc.ec.n}`, bName: `${t('ecNo')} ${cc.non.n}` }
        );
    }
    $('#cartSection').innerHTML = TTCollapse.html({ id: 'chart:cart', title: esc(t('ecTitle')), meta: esc(t('cartMethodNote_' + mode)), summary, extra: seg, body });
  }

  /* ---------------- 本期 vs 对比期（默认收起） ---------------- */
  const PC_LABEL = {
    videos: 'kpiVideos', views: 'kpiViews', likes: 'colLikes', comments: 'colComments', shares: 'colShares', saves: 'colSaves', reposts: 'colReposts',
    videosPerDay: 'pcVideosPerDay', viewsPerDay: 'pcViewsPerDay', avgViews: 'kpiAvgViews', medViews: 'pcMedViews', avgInteractions: 'pcAvgInter', inter: 'colEngage',
  };
  function renderPeriod(rows, ctx) {
    const host = $('#periodSection');
    if (!ctx) {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const v = state.view;
    const { pc, insufficient, gaps } = ctx;
    const info = v.info || TTPeriod.compareRange(v.mode, v.currentFrom, v.currentTo, { from: v.compareFrom, to: v.compareTo }) || {};
    const by = Object.fromEntries(pc.metrics.map((m) => [m.key, m]));
    const chip = (k) => (insufficient ? `<span class="delta na">${esc(t('insufficientShort'))}</span>` : by[k].kind === 'pct' ? ppChip(by[k].abs) : deltaChip(by[k].pct));
    const main = pc.sameSpan ? 'views' : 'viewsPerDay';
    const notes = [];
    if (info.shiftedWeek) notes.push(t('warnShiftedWeek', { n: pc.currentDays }));
    if (info.overlapDays) notes.push(t('warnOverlapResult', { n: info.overlapDays }));
    if (info.clamped) notes.push(t('warnClamped'));
    if (info.fullMonth) notes.push(t('noteFullMonth')); // 2.2 之前的历史任务
    if (!pc.sameSpan) notes.push(t('warnSpan', { a: pc.currentDays, b: pc.compareDays }));
    notes.push(t('pcSnapNote'));

    let last = '';
    const rowsHtml = pc.metrics
      .map((m) => {
        const g = m.group !== last ? `<tr class="grp"><td colspan="5">${esc(t('pcGroup_' + m.group))}</td></tr>` : '';
        last = m.group;
        return `${g}<tr><td>${esc(t(PC_LABEL[m.key]))}</td><td class="num">${fmtKind(m.cur, m.kind)}</td><td class="num">${insufficient ? `<span class="muted">${esc(t('insufficientShort'))}</span>` : fmtKind(m.cmp, m.kind)}</td><td class="num">${insufficient ? DASH : fmtSigned(m.abs, m.kind)}</td><td class="num">${insufficient || m.kind === 'pct' ? (m.kind === 'pct' && !insufficient ? ppChip(m.abs) : DASH) : deltaChip(m.pct, { naTitle: m.cmp === 0 ? t('deltaZeroBase') : t('deltaNa') })}</td></tr>`;
      })
      .join('');
    host.innerHTML = TTCollapse.html({
      id: 'period',
      title: esc(t('pcTitle')),
      meta: esc(notes.join('\n')),
      summary: `<span>${esc(t(PC_LABEL[main]))}</span> ${chip(main)} <span>${esc(t('colEngage'))}</span> ${chip('inter')}`,
      body: `
        <div class="pc-ranges">
          <div>${esc(t('pcCur'))}<b>${esc(v.currentFrom)} ~ ${esc(v.currentTo)}</b>${esc(t('nDays', { n: pc.currentDays }))} · ${esc(t('videosN', { n: pc.current.n }))}</div>
          <div class="cmp">${esc(t('cmpMode_' + v.mode))}<b>${esc(v.compareFrom)} ~ ${esc(v.compareTo)}</b>${esc(t('nDays', { n: pc.compareDays }))} · ${esc(insufficient ? t('insufficientShort') : t('videosN', { n: pc.compare.n }))}</div>
        </div>
        ${insufficient ? `<div class="notice err" style="margin-bottom:12px"><span>${esc(t('pcInsufficient', { list: gaps.map((g) => `@${g.handle} ≥ ${g.from}`).join('，') }))}</span></div>` : ''}
        ${pc.compareEmpty && !insufficient ? `<div class="notice warn" style="margin-bottom:12px"><span>${esc(t('pcCompareEmpty'))}</span></div>` : ''}
        <div class="tbl-wrap compact"><table>
          <thead><tr><th>${esc(t('ecMetric'))}</th><th class="num">${esc(t('pcCur'))}</th><th class="num">${esc(t('pcCmp'))}</th><th class="num">${esc(t('diffAbs'))}</th><th class="num">${esc(t('diffPct'))}</th></tr></thead>
          <tbody>${rowsHtml}</tbody></table></div>`,
    });
  }

  /* ---------------- AI 分析（概览） ---------------- */
  function renderAi() {
    const host = $('#aiSection');
    const jobId = state.jobId;
    if (!state.aiConfigured || !jobId || !state.job) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    host.hidden = false;
    const r = aiCache.get(jobId);
    const body = !r
      ? `<div class="skel skel-line" style="width:90%"></div><div class="skel skel-line" style="width:75%"></div><div class="skel skel-line" style="width:60%"></div>`
      : r.error
      ? `<div class="notice err"><span>${esc(r.error)}</span><button type="button" class="xs" data-ai-retry>${esc(t('retry'))}</button></div>`
      : `<div class="ai-md">${esc(r.brief).replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</div>`;
    host.innerHTML = TTCollapse.html({
      id: 'ai',
      open: true,
      title: esc(t('aiBriefTitle')),
      summary: !r ? `<span class="spin"></span>` : r.error ? `<span class="err">${esc(t('aiFailedShort'))}</span>` : '',
      extra: r && !r.error ? `<button type="button" class="xs ghost" data-ai-regen>${esc(t('aiBriefRegen'))}</button>` : '',
      body,
    });
    if (!r) loadAi(jobId);
  }
  async function loadAi(jobId, force) {
    if (force) {
      aiCache.delete(jobId);
      try {
        await api(`/api/jobs/${encodeURIComponent(jobId)}/ai-brief`, { method: 'DELETE' });
      } catch (_) {}
      return renderAi();
    }
    if (aiCache.has(jobId + ':loading')) return;
    aiCache.set(jobId + ':loading', 1);
    try {
      const r = await jget(`/api/jobs/${encodeURIComponent(jobId)}/ai-brief`);
      aiCache.set(jobId, { brief: r.brief, cached: r.cached });
    } catch (e) {
      aiCache.set(jobId, { error: e.message });
    } finally {
      aiCache.delete(jobId + ':loading');
    }
    if (state.jobId === jobId) renderAi();
  }

  /* ---------------- 复制简报：当前视图的结论，直接贴进飞书 / 群聊 ---------------- */
  function briefText() {
    const v = state.view;
    const rows = selectedRows();
    const cur = TTMetrics.aggregate(rows.filter(TTMetrics.inCurrent));
    const ctx = compareContext(rows);
    const who = state.account === '__all__' ? (state.job.handles || []).map((h) => '@' + h).join(' ') : '@' + state.account;
    const pct = (x) => (isNum(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%` : DASH);
    const L = [];
    L.push(`【${t('briefTitle')}】${who}`);
    L.push(`${t('pcCur')} ${v.currentFrom} ~ ${v.currentTo}（${t('nDays', { n: TTPeriod.span(v.currentFrom, v.currentTo) })}）`);
    L.push(`· ${t('kpiVideos')} ${fmtInt(cur.n)} ｜ ${t('kpiViews')} ${fmtInt(cur.views)} ｜ ${t('kpiAvgViews')} ${fmtInt(cur.avgViews)}`);
    L.push(`· ${t('colEngage')} ${fmtPct(cur.inter)} ｜ ${t('kpiEcShare')} ${fmtPct(cur.ecShare, 0)}`);
    if (ctx) {
      const m = Object.fromEntries(ctx.pc.metrics.map((x) => [x.key, x]));
      L.push(`${t('cmpMode_' + v.mode)} ${v.compareFrom} ~ ${v.compareTo}`);
      if (ctx.insufficient) L.push(`· ${t('insufficientShort')}`);
      else {
        const key = ctx.pc.sameSpan ? 'views' : 'viewsPerDay';
        L.push(`· ${t(PC_LABEL[key])} ${pct(m[key].pct)} ｜ ${t('kpiAvgViews')} ${pct(m.avgViews.pct)} ｜ ${t('kpiVideos')} ${pct(m.videos.pct)}`);
        L.push(`· ${t('colEngage')} ${isNum(m.inter.abs) ? `${m.inter.abs > 0 ? '+' : ''}${(m.inter.abs * 100).toFixed(2)}${t('ppShort')}` : DASH}`);
      }
    }
    const cc = TTMetrics.cartCompare(rows.filter(TTMetrics.inCurrent), prefs.get('cartMode', 'mean'));
    if (cc.ec.n && cc.non.n) {
      const vw = cc.metrics.find((x) => x.key === 'views');
      L.push(`${t('ecTitle')}（${t('cartMode_' + cc.mode)}）`);
      L.push(`· ${t('cartAvgViews')} ${fmtInt(vw.ec.value)} vs ${fmtInt(vw.non.value)}（${pct(vw.pct)}）`);
    }
    const { best } = hourStats(rows.filter(TTMetrics.inCurrent));
    if (best.length) L.push(`${t('bestHours')} ${best.map((h) => String(h).padStart(2, '0') + ':00').join(' / ')}`);
    const top = rows.filter(TTMetrics.inCurrent).sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 3);
    if (top.length) {
      L.push(t('briefTop'));
      top.forEach((r, i) => L.push(`${i + 1}. ${fmtInt(r.views)} · ${r.date}${r.isEC ? ' · ' + t('colShopping') : ''} · ${(r.desc || '').slice(0, 30)}`));
    }
    return L.join('\n');
  }

  /* ---------------- 总渲染 ---------------- */
  function render() {
    const has = !!state.job && state.rows.length > 0;
    $('#results').hidden = !has;
    $('#emptyState').hidden = has;
    if (!has) return;
    const rows = selectedRows();
    const ctx = compareContext(rows);
    renderHead();
    renderBanner();
    renderKpis(rows, ctx);
    renderAi();
    renderDaily(rows, ctx);
    renderHours(rows);
    renderAccounts();
    renderCart(rows);
    renderPeriod(rows, ctx);
    TTChart.mountAll($('#results'));
    renderCreator();
    TTTable.render();
  }

  function load(job) {
    state.job = job;
    state.jobId = job.id;
    state.rows = job.rows || [];
    state.view = viewFromJob(job);
    state.mismatch = null;
    if (!accounts().includes(state.account)) state.account = '__all__';
    TTFilter.setFromJob(job);
    render();
  }

  function onFilter(snap) {
    if (!state.job || state.busy) return;
    const c = snap.compare;
    const want = { currentFrom: snap.from, currentTo: snap.to, compareFrom: c ? c.from : null, compareTo: c ? c.to : null, mode: c ? snap.mode : 'none', info: c || null };
    if (sameView(want, state.view)) return;
    if (covered(want)) {
      state.view = want;
      state.mismatch = null;
      reclassify(want);
    } else {
      state.mismatch = {
        lo: want.compareFrom && want.compareFrom < want.currentFrom ? want.compareFrom : want.currentFrom,
        hi: want.compareTo && want.compareTo > want.currentTo ? want.compareTo : want.currentTo,
      };
    }
    render();
  }

  function init() {
    TTFilter.onChange(onFilter);
    $('#results').addEventListener('click', (e) => {
      const acct = e.target.closest('[data-acct]');
      if (acct) {
        state.account = acct.dataset.acct;
        return render();
      }
      const dm = e.target.closest('[data-daily]');
      if (dm) {
        prefs.set('dailyMetric', dm.dataset.daily);
        const rows = selectedRows();
        renderDaily(rows, compareContext(rows));
        return TTChart.mountAll($('#chartDaily'));
      }
      const cm = e.target.closest('[data-cart]');
      if (cm) {
        prefs.set('cartMode', cm.dataset.cart);
        return renderCart(selectedRows());
      }
      if (e.target.closest('[data-rescrape]')) return TTApp.start();
      if (e.target.closest('[data-ai-regen]')) return loadAi(state.jobId, true);
      if (e.target.closest('[data-ai-retry]')) {
        aiCache.delete(state.jobId);
        return renderAi();
      }
      const dl = e.target.closest('[data-dl-handle]');
      if (dl) return TTTable.downloadHandle(dl.dataset.dlHandle, dl);
      const cr = e.target.closest('[data-cr-refresh]');
      if (cr) {
        const done = btnBusy(cr, t('crFetching'));
        jpost('/api/tiktok-login/sync-now')
          .then((r) => toast(t('syncOkN', { n: r.n || 0 }), 'ok'))
          .catch((err) => toast(t('syncFailed', { err: err.message }), 'err'))
          .finally(() => {
            done();
            renderCreator(true);
          });
      }
    });
    $('#copyBrief').addEventListener('click', () => {
      if (!state.job) return;
      navigator.clipboard.writeText(briefText()).then(
        () => toast(t('briefCopied'), 'ok'),
        () => toast(t('copyFailed'), 'err')
      );
    });
    $('#acctTabs').addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const btns = $$('#acctTabs [data-acct]');
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length].focus();
    });
  }

  return { init, load, render, selectedRows, briefText, refreshCreator: () => renderCreator(true) };
})();

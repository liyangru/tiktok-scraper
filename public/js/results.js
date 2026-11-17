/* ============================================================
   结果区：数据概览 → 图表分析 → 挂车对比 → 周期对比（视频明细在 table.js）

   数据口径（全部来自 public/shared/metrics.js，与导出共用）：
   - 概览、图表、挂车对比只统计「本期」；周期对比同时看两期
   - 切换日期 / 对比方式时：只要新区间仍在这次抓取覆盖的范围内，就直接用已抓到的真实视频重算；
     超出范围就明确提示需要重新抓取 —— 绝不拿不覆盖的数据假装做了对比
   ============================================================ */
const TTResults = (() => {
  let creatorCache = null; // { at, data }
  const aiCache = new Map(); // jobId → { brief, cached } | { error }

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

  /** 选中账号的覆盖问题：哪些账号没有完整加载到所需的最早日期 */
  function coverageGaps(view, accounts) {
    const job = state.job;
    if (!job || !view) return [];
    const need = view.compareFrom && view.compareFrom < view.currentFrom ? view.compareFrom : view.currentFrom;
    return (job.coverage || []).filter((c) => !c.error && (!accounts || accounts.includes(c.handle)) && c.from > need);
  }

  /** 该区间是否被这次抓取覆盖（抓取范围 = 本期 ∪ 对比期） */
  function covered(view) {
    const job = state.job;
    if (!job) return false;
    const lo = view.compareFrom && view.compareFrom < view.currentFrom ? view.compareFrom : view.currentFrom;
    const hi = view.compareTo && view.compareTo > view.currentTo ? view.compareTo : view.currentTo;
    return lo >= job.from && hi <= job.to;
  }

  /* ---------------- 选中账号的行 ---------------- */
  const accounts = () => [...new Set(state.rows.filter((r) => !r.fromLink).map((r) => r.account))];
  const selectedRows = () => state.rows.filter((r) => !r.fromLink && (state.account === '__all__' || r.account === state.account));
  const selectedAccounts = () => (state.account === '__all__' ? (state.job && state.job.handles) || accounts() : [state.account]);

  /* ---------------- 每日序列（按发布日汇总） ----------------
     「播放」是当天发布的视频截至抓取时的累计播放；当天没发视频 → 没有数据（断线），
     发布数则是真实的 0。超过 120 天按周汇总，避免几千个点挤成一团。 */
  function series(rows, from, to, metric) {
    if (!from || !to) return { points: [], weekly: false };
    const days = TTPeriod.span(from, to);
    const weekly = days > 120;
    const keyOf = (d) => (weekly ? TTPeriod.weekStart(d) : d);
    const buckets = new Map();
    let cursor = weekly ? TTPeriod.weekStart(from) : from;
    while (cursor <= to) {
      buckets.set(cursor, { n: 0, views: 0, inter: 0 });
      cursor = TTPeriod.addDays(cursor, weekly ? 7 : 1);
    }
    for (const r of rows) {
      if (!r.date || r.date < from || r.date > to || !isNum(r.views)) continue;
      const b = buckets.get(keyOf(r.date));
      if (!b) continue;
      b.n++;
      b.views += r.views;
      b.inter += TTMetrics.interactionsOf(r);
    }
    const points = [...buckets.entries()].map(([d, b]) => {
      let v;
      if (metric === 'posts') v = b.n;
      else if (metric === 'inter') v = b.views > 0 ? b.inter / b.views : null;
      else v = b.n ? b.views : null;
      return {
        x: weekly ? shortDate(d) : shortDate(d),
        label: weekly ? `${d} ~ ${TTPeriod.addDays(d, 6)}` : d,
        v,
        note: b.n ? t('postsN', { n: b.n }) : t('noPostsDay'),
      };
    });
    return { points, weekly };
  }

  /* ---------------- 顶部：期次说明 + 账号切换 + 导出 ---------------- */
  function renderHead() {
    const v = state.view;
    const job = state.job;
    const parts = [
      `<span class="rm-k">${esc(t('pcCur'))}</span> <b>${esc(rangeText(v.currentFrom, v.currentTo))}</b> <span class="rm-d">${esc(t('nDays', { n: TTPeriod.span(v.currentFrom, v.currentTo) }))}</span>`,
    ];
    if (v.compareFrom) {
      parts.push(
        `<span class="rm-k">${esc(t('cmpMode_' + (v.mode || 'custom')))}</span> <b>${esc(rangeText(v.compareFrom, v.compareTo))}</b> <span class="rm-d">${esc(t('nDays', { n: TTPeriod.span(v.compareFrom, v.compareTo) }))}</span>`
      );
    }
    $('#resultMeta').innerHTML = parts.join('<span class="rm-sep">vs</span>');

    const accs = accounts();
    const tabs = $('#acctTabs');
    if (accs.length > 1) {
      tabs.hidden = false;
      tabs.innerHTML =
        `<button type="button" role="radio" data-acct="__all__" aria-checked="${state.account === '__all__'}" class="${state.account === '__all__' ? 'on' : ''}">${esc(t('allAccounts'))}</button>` +
        accs.map((a) => `<button type="button" role="radio" data-acct="${esc(a)}" aria-checked="${state.account === a}" class="${state.account === a ? 'on' : ''}">@${esc(a)}</button>`).join('');
    } else {
      tabs.hidden = true;
      tabs.innerHTML = '';
    }
    const diff = job && !sameView(v, viewFromJob(job));
    const exp = $('#exportNote');
    if (exp) {
      exp.hidden = !diff;
      exp.textContent = diff ? t('exportUsesJob', { range: rangeText(job.currentFrom, job.currentTo) }) : '';
    }
    $('#exportXlsx').disabled = $('#exportCsv').disabled = state.busy || !job || !state.rows.length;
  }

  /* ---------------- 数据提示（覆盖范围 / 区间不匹配） ---------------- */
  function renderBanner() {
    const host = $('#dataBanner');
    const msgs = [];
    if (state.mismatch) {
      msgs.push(
        `<div class="banner warn"><div><b>${esc(t('mismatchTitle'))}</b><span>${esc(
          t('mismatchBody', { have: rangeText(state.job.from, state.job.to), want: rangeText(state.mismatch.lo, state.mismatch.hi) })
        )}</span></div><button type="button" class="btn sm primary" data-rescrape>${esc(t('rescrape'))}</button></div>`
      );
    }
    const gaps = coverageGaps(state.view, selectedAccounts());
    if (gaps.length) {
      msgs.push(
        `<div class="banner warn"><div><b>${esc(t('gapTitle'))}</b><span>${esc(
          t('gapBody', { list: gaps.map((g) => `@${g.handle} ≥ ${g.from}`).join('，') })
        )}</span></div></div>`
      );
    }
    const failed = (state.job && state.job.coverage ? state.job.coverage : []).filter((c) => c.error);
    if (failed.length) {
      msgs.push(`<div class="banner err"><div><b>${esc(t('failedAccTitle'))}</b><span>${esc(failed.map((c) => `@${c.handle}：${c.error}`).join('；'))}</span></div></div>`);
    }
    host.innerHTML = msgs.join('');
    host.hidden = !msgs.length;
  }

  /* ---------------- 概览 KPI（不折叠：核心数据一眼可见） ---------------- */
  const KPIS = [
    { key: 'videos', label: 'kpiVideos', get: (a) => a.n, kind: 'int', total: true },
    { key: 'views', label: 'kpiViews', get: (a) => a.views, kind: 'int', total: true },
    { key: 'avgViews', label: 'kpiAvgViews', get: (a) => a.avgViews, kind: 'int' },
    { key: 'likes', label: 'colLikes', get: (a) => a.likes, kind: 'int', total: true },
    { key: 'comments', label: 'colComments', get: (a) => a.comments, kind: 'int', total: true },
    { key: 'shares', label: 'colShares', get: (a) => a.shares, kind: 'int', total: true },
    { key: 'saves', label: 'colSaves', get: (a) => a.saves, kind: 'int', total: true },
    { key: 'inter', label: 'colEngage', get: (a) => a.inter, kind: 'pct', hint: 'kpiInterHint' },
    { key: 'ecShare', label: 'kpiEcShare', get: (a) => a.ecShare, kind: 'pct' },
  ];

  function compareContext(rows) {
    const v = state.view;
    if (!v.compareFrom) return null;
    const gaps = coverageGaps(v, selectedAccounts()).filter((g) => g.from > v.compareFrom);
    const pc = TTMetrics.periodCompare(rows, v);
    return { pc, insufficient: gaps.length > 0, gaps };
  }

  function renderKpis(rows, ctx) {
    const cur = TTMetrics.aggregate(rows.filter(TTMetrics.inCurrent));
    const cmpRows = ctx ? rows.filter(TTMetrics.inCompare) : [];
    const cmp = ctx ? TTMetrics.aggregate(cmpRows) : null;
    const curDays = TTPeriod.span(state.view.currentFrom, state.view.currentTo);
    const cmpDays = ctx ? TTPeriod.span(state.view.compareFrom, state.view.compareTo) : 0;
    const same = curDays === cmpDays;

    $('#kpis').innerHTML = KPIS.map((k) => {
      const val = k.get(cur);
      let sub = '';
      if (k.key === 'ecShare') sub = `<span class="kpi-sub">${esc(t('ecOfN', { a: cur.ecN, n: cur.n }))}</span>`;
      if (k.key === 'avgViews' && isNum(cur.medViews)) sub = `<span class="kpi-sub">${esc(t('medianX', { v: fmtCompact(cur.medViews) }))}</span>`;
      let delta = '';
      if (ctx) {
        if (ctx.insufficient) delta = `<span class="delta na" title="${esc(t('insufficientTip'))}">${esc(t('insufficientShort'))}</span>`;
        else {
          let a = val, b = k.get(cmp), label = t('vsCmp');
          if (k.total && !same) {
            a = isNum(a) ? a / curDays : null;
            b = isNum(b) ? b / cmpDays : null;
            label = t('vsCmpPerDay');
          }
          const d = TTMetrics.delta(a, b);
          const title = `${t('pcCmp')}: ${fmtKind(k.get(cmp), k.kind)}${k.total && !same ? ` · ${t('perDay')} ${fmtDec(b, 1)}` : ''}`;
          if (k.kind === 'pct') {
            delta = isNum(d.abs)
              ? `<span class="delta ${d.abs > 0.00005 ? 'up' : d.abs < -0.00005 ? 'down' : 'flat'}" title="${esc(title)}">${d.abs > 0.00005 ? '▲' : d.abs < -0.00005 ? '▼' : ''}${Math.abs(d.abs * 100).toFixed(2)} ${esc(t('pp'))}</span>`
              : deltaChip(null, { naTitle: t('deltaNa') });
          } else delta = deltaChip(d.pct, { title });
          delta += `<span class="kpi-vs">${esc(label)}</span>`;
        }
      }
      return `<div class="kpi" title="${k.hint ? esc(t(k.hint)) : ''}">
        <div class="kpi-label">${esc(t(k.label))}</div>
        <div class="kpi-value">${esc(fmtKind(val, k.kind))}</div>
        <div class="kpi-foot">${sub}${delta}</div>
      </div>`;
    }).join('');
  }

  /* ---------------- 账号表现（KPI 常显，迷你趋势可折叠） ---------------- */
  function renderAccounts() {
    const host = $('#accountCards');
    const accs = accounts();
    const summary = (state.job && state.job.summary) || [];
    const v = state.view;
    if (!accs.length) {
      host.innerHTML = '';
      return;
    }
    host.innerHTML = `<div class="acct-grid">${accs
      .map((h) => {
        const rows = state.rows.filter((r) => !r.fromLink && r.account === h && TTMetrics.inCurrent(r));
        const a = TTMetrics.aggregate(rows);
        const s = summary.find((x) => x.handle === h) || {};
        const fans = s.stats && s.stats.followerCount;
        const ser = series(rows, v.currentFrom === TTPeriod.ALL_FROM && rows.length ? rows.reduce((m, r) => (r.date < m ? r.date : m), v.currentTo) : v.currentFrom, v.currentTo, 'views');
        const peak = ser.points.reduce((m, p) => (isNum(p.v) && (!m || p.v > m.v) ? p : m), null);
        const sel = state.account === h;
        return `<div class="acct-card${sel ? ' sel' : ''}">
          <div class="ac-head"><b>@${esc(h)}</b>${s.nickname ? `<span>${esc(s.nickname)}</span>` : ''}
            <button type="button" class="icon-btn sm" data-dl-handle="${esc(h)}" title="${esc(t('cardDownload'))}" aria-label="${esc(t('cardDownload'))}">⤓</button></div>
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
            meta: esc(ser.weekly ? t('byWeek') : t('byPostDay')),
            summary: peak ? `<span class="sum-k">${esc(t('peak'))}</span> <b>${esc(peak.x)}</b> ${esc(fmtCompact(peak.v))}` : `<span class="muted">${esc(t('noDataShort'))}</span>`,
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
    const host = $('#chartDaily');
    const v = state.view;
    const metric = DAILY_METRICS.find((m) => m.key === prefs.get('dailyMetric', 'views')) || DAILY_METRICS[0];
    let from = v.currentFrom;
    const curRows = rows.filter(TTMetrics.inCurrent);
    if (TTPeriod.isAll(from)) from = curRows.reduce((m, r) => (r.date < m ? r.date : m), v.currentTo);
    const cur = series(curRows, from, v.currentTo, metric.key);
    const ser = [{ name: `${t('pcCur')} ${rangeText(from, v.currentTo)}`, tone: 'cur', points: cur.points }];
    if (ctx && !ctx.insufficient) {
      const cmp = series(rows.filter(TTMetrics.inCompare), v.compareFrom, v.compareTo, metric.key);
      // 对比期按「第 N 天」与本期对齐叠加，横轴仍显示本期日期，提示框里显示对比期的真实日期
      const pts = cmp.points.map((p, i) => ({ ...p, x: cur.points[i] ? cur.points[i].x : p.x }));
      ser.push({ name: `${t('pcCmp')} ${rangeText(v.compareFrom, v.compareTo)}`, tone: 'cmp', dashed: true, points: pts });
    }
    const vals = cur.points.filter((p) => isNum(p.v));
    const peak = vals.reduce((m, p) => (!m || p.v > m.v ? p : m), null);
    const total = TTMetrics.aggregate(curRows);
    const summary =
      metric.key === 'posts'
        ? `<b>${fmtInt(total.n)}</b> ${esc(t('unitPostsShort'))} · ${esc(t('activeDays', { n: vals.filter((p) => p.v > 0).length }))}`
        : peak
        ? `<span class="sum-k">${esc(t('peak'))}</span> <b>${esc(peak.x)}</b> ${esc(metric.kind === 'pct' ? fmtPct(peak.v) : fmtCompact(peak.v))}`
        : `<span class="muted">${esc(t('noDataShort'))}</span>`;
    const seg = `<div class="seg xs" role="radiogroup" aria-label="${esc(t('metric'))}">${DAILY_METRICS.map(
      (m) => `<button type="button" role="radio" data-daily="${m.key}" aria-checked="${m === metric}" class="${m === metric ? 'on' : ''}">${esc(t(m.label))}</button>`
    ).join('')}</div>`;
    host.innerHTML = TTCollapse.html({
      id: 'chart:daily',
      title: esc(t('dailyTitle')),
      meta: esc(cur.weekly ? t('dailyMetaWeekly') : t('dailyMeta')),
      summary,
      extra: seg,
      body:
        TTChart.placeholder({ series: ser, unit: t(metric.unit), kind: metric.kind, empty: t('chartEmptyPosts'), aria: t('dailyTitle') }) +
        `<p class="fineprint">${esc(metric.key === 'posts' ? t('dailyPostsNote') : t('dailyNote'))}</p>`,
    });
  }

  /* ---------------- 创作中心趋势（每个指标一张可折叠小图） ---------------- */
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
    const upd = d.at ? new Date(Date.parse(d.at) + 7 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
    const items = CR_METRICS.filter((m) => Array.isArray(s[m.key]) && s[m.key].length).map((m) => {
      let vals = s[m.key].map((x) => (x === null || x === undefined || x === '' ? null : Number(x))).map((x) => (Number.isFinite(x) ? x : null));
      const real = vals.filter(isNum);
      if (m.pct && real.length && Math.max(...real) > 1) vals = vals.map((x) => (isNum(x) ? x / 100 : x));
      const n = vals.length;
      // 创作中心只给按天排列的序列、不带日期：横轴如实写「距最新 N 天」，不去猜具体日期
      const pts = vals.map((v, i) => ({ x: i === n - 1 ? t('latest') : `-${n - 1 - i}${t('dayShort')}`, label: i === n - 1 ? t('latest') : t('daysAgo', { n: n - 1 - i }), v }));
      const first = real[0], last = real[real.length - 1];
      const d2 = TTMetrics.delta(last, first);
      const summary = real.length >= 2
        ? `${esc(m.pct ? fmtPct(first, 1) : fmtCompact(first))} → <b>${esc(m.pct ? fmtPct(last, 1) : fmtCompact(last))}</b> ${deltaChip(d2.pct)}`
        : `<span class="muted">${esc(t('chartSinglePointShort'))}</span>`;
      return TTCollapse.html({
        id: 'creator:' + m.key,
        variant: 'item',
        title: esc(t(m.label)),
        meta: esc(t('lastNDays', { n })),
        summary,
        body: TTChart.placeholder({ series: [{ name: t(m.label), points: pts }], unit: t(m.unit), kind: m.pct ? 'pct' : 'int', height: 160 }),
      });
    });
    const traffic = Array.isArray(meta.traffic) ? meta.traffic.slice(0, 6) : [];
    const terms = Array.isArray(meta.searchTerms) ? meta.searchTerms.slice(0, 8) : [];
    const foot = [];
    if (traffic.length)
      foot.push(`<div class="cr-foot"><b>${esc(t('crTraffic'))}</b>${traffic.map((x) => `<span class="tag">${esc(CR_TRAFFIC[x.key] ? t(CR_TRAFFIC[x.key]) : x.key)} ${(Number(x.pct) || 0).toFixed(1)}%</span>`).join('')}</div>`);
    if (terms.length) foot.push(`<div class="cr-foot"><b>${esc(t('crSearch'))}</b>${terms.map((x) => `<span class="tag">${esc(String(x))}</span>`).join('')}</div>`);
    host.innerHTML = TTCollapse.html({
      id: 'chart:creator',
      title: esc(t('crTitle')),
      meta: esc([d.handle ? '@' + d.handle : '', upd ? t('crUpdated', { t: upd }) : ''].filter(Boolean).join(' · ')),
      summary: `<span class="muted">${esc(t('crSummary', { n: items.length }))}</span>${meta.followers ? ` · ${esc(t('followers'))} <b>${esc(fmtCompact(meta.followers))}</b>` : ''}`,
      extra: `<button type="button" class="btn xs ghost" data-cr-refresh>${esc(t('crRefresh'))}</button>`,
      body: `<div class="cx-stack">${items.join('') || `<div class="chart-empty">${esc(t('crNoSeries'))}</div>`}</div>${foot.join('')}`,
    });
    TTChart.mountAll(host);
  }

  /* ---------------- 挂车 vs 非挂车 ---------------- */
  const CART_LABEL = { views: 'cartAvgViews', likes: 'cartAvgLikes', comments: 'cartAvgComments', shares: 'cartAvgShares', saves: 'cartAvgSaves', inter: 'colEngage' };
  function renderCart(rows) {
    const host = $('#cartSection');
    const mode = prefs.get('cartMode', 'mean');
    const cc = TTMetrics.cartCompare(rows.filter(TTMetrics.inCurrent), mode);
    const seg = `<div class="seg xs" role="radiogroup" aria-label="${esc(t('cartMethod'))}">${TTMetrics.CART_MODES.map(
      (m) => `<button type="button" role="radio" data-cart="${m}" aria-checked="${m === mode}" class="${m === mode ? 'on' : ''}">${esc(t('cartMode_' + m))}</button>`
    ).join('')}</div>`;
    const views = cc.metrics.find((m) => m.key === 'views');
    const summary =
      cc.ec.n && cc.non.n
        ? `${esc(t('cartCounts', { a: cc.ec.n, b: cc.non.n }))} · ${esc(t('cartAvgViews'))} ${deltaChip(views.pct, { title: t('cartDeltaTip') })}`
        : `<span class="muted">${esc(t('cartCounts', { a: cc.ec.n, b: cc.non.n }))}</span>`;

    let body;
    if (!cc.ec.n || !cc.non.n) {
      body = `<div class="chart-empty">${esc(!cc.ec.n && !cc.non.n ? t('noData') : !cc.ec.n ? t('cartNoEc') : t('cartNoNon'))}</div>`;
    } else {
      const notes = [`<p class="fineprint">${esc(t('cartMethodNote_' + cc.mode))}</p>`];
      if (cc.fallback.ec || cc.fallback.non) {
        notes.push(`<div class="note warn">${esc(t('cartFallback', { group: [cc.fallback.ec ? t('ecYes') : '', cc.fallback.non ? t('ecNo') : ''].filter(Boolean).join(' / '), n: TTMetrics.TRIM_MIN_N }))}</div>`);
      }
      const sampleNote = (g) => (cc.mode === 'trim' && g.trimmed ? t('cartUsed', { used: g.used, n: g.n }) : '');
      const bars = TTChart.pairBars(
        cc.metrics.map((m) => ({
          label: t(CART_LABEL[m.key]),
          a: m.ec.value,
          b: m.non.value,
          kind: m.kind,
          aNote: sampleNote(m.ec),
          bNote: sampleNote(m.non),
          delta: m.kind === 'pct'
            ? isNum(m.abs) ? `<span class="delta ${m.abs > 0 ? 'up' : m.abs < 0 ? 'down' : 'flat'}">${m.abs > 0 ? '▲' : m.abs < 0 ? '▼' : ''}${Math.abs(m.abs * 100).toFixed(2)} ${esc(t('pp'))}</span>` : deltaChip(null)
            : deltaChip(m.pct, { title: t('cartDeltaTip') }),
        })),
        { aName: `${t('ecYes')} (${cc.ec.n})`, bName: `${t('ecNo')} (${cc.non.n})` }
      );
      const table = `<div class="tbl-wrap compact"><table class="data">
        <thead><tr><th>${esc(t('ecMetric'))}</th><th class="num">${esc(t('ecYes'))}</th><th class="num">${esc(t('ecNo'))}</th><th class="num">${esc(t('diffAbs'))}</th><th class="num">${esc(t('diffPct'))}</th></tr></thead>
        <tbody>
          <tr><td>${esc(t('kpiVideos'))}</td><td class="num">${fmtInt(cc.ec.n)}</td><td class="num">${fmtInt(cc.non.n)}</td><td class="num">${fmtSigned(cc.ec.n - cc.non.n, 'int')}</td><td class="num">${DASH}</td></tr>
          ${cc.metrics
            .map((m) => `<tr><td>${esc(t(CART_LABEL[m.key]))}</td><td class="num">${fmtKind(m.ec.value, m.kind)}</td><td class="num">${fmtKind(m.non.value, m.kind)}</td><td class="num">${fmtSigned(m.abs, m.kind)}</td><td class="num">${m.kind === 'pct' ? DASH : deltaChip(m.pct)}</td></tr>`)
            .join('')}
        </tbody></table></div>`;
      body = notes.join('') + bars + table;
    }
    host.innerHTML = TTCollapse.html({ id: 'chart:cart', title: esc(t('ecTitle')), meta: esc(t('cartMeta')), summary, extra: seg, body });
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
    const byKey = Object.fromEntries(pc.metrics.map((m) => [m.key, m]));
    const keyDelta = (k) => {
      const m = byKey[k];
      if (insufficient) return `<span class="delta na">${esc(t('insufficientShort'))}</span>`;
      return m.kind === 'pct'
        ? isNum(m.abs) ? `<span class="delta ${m.abs > 0 ? 'up' : m.abs < 0 ? 'down' : 'flat'}">${m.abs > 0 ? '▲' : m.abs < 0 ? '▼' : ''}${Math.abs(m.abs * 100).toFixed(2)} ${esc(t('pp'))}</span>` : deltaChip(null)
        : deltaChip(m.pct);
    };
    const mainViews = pc.sameSpan ? 'views' : 'viewsPerDay';
    const summary = `<span class="pc-ranges"><b>${esc(rangeText(v.currentFrom, v.currentTo))}</b> vs <b>${esc(rangeText(v.compareFrom, v.compareTo))}</b> <span class="muted">${esc(t('cmpMode_' + v.mode))}</span></span>
      <span class="pc-keys">${esc(t(PC_LABEL[mainViews]))} ${keyDelta(mainViews)} · ${esc(t('colEngage'))} ${keyDelta('inter')}</span>`;

    const notes = [];
    if (insufficient) notes.push(['err', t('pcInsufficient', { list: gaps.map((g) => `@${g.handle} ≥ ${g.from}`).join('，') })]);
    if (pc.compareEmpty && !insufficient) notes.push(['warn', t('pcCompareEmpty')]);
    if (info.shiftedWeek) notes.push(['warn', t('warnShiftedWeek', { n: pc.currentDays })]);
    if (info.overlapDays) notes.push(['warn', t('warnOverlapResult', { n: info.overlapDays })]);
    if (info.clamped) notes.push(['info', t('warnClamped')]);
    if (info.fullMonth) notes.push(['info', t('noteFullMonth')]);
    if (!pc.sameSpan) notes.push(['info', t('warnSpan', { a: pc.currentDays, b: pc.compareDays })]);
    notes.push(['info', t('pcSnapNote')]);

    let lastGroup = '';
    const rowsHtml = pc.metrics
      .map((m) => {
        let g = '';
        if (m.group !== lastGroup) {
          lastGroup = m.group;
          g = `<tr class="grp"><td colspan="5">${esc(t('pcGroup_' + m.group))}${m.group === 'total' && !pc.sameSpan ? ` <span class="muted">· ${esc(t('pcTotalsCaution'))}</span>` : ''}</td></tr>`;
        }
        const cmpCell = insufficient ? `<span class="muted">${esc(t('insufficientShort'))}</span>` : fmtKind(m.cmp, m.kind);
        return `${g}<tr><td>${esc(t(PC_LABEL[m.key]))}</td><td class="num">${fmtKind(m.cur, m.kind)}</td><td class="num">${cmpCell}</td><td class="num">${insufficient ? DASH : fmtSigned(m.abs, m.kind)}</td><td class="num">${
          insufficient ? DASH : m.kind === 'pct' ? DASH : deltaChip(m.pct, { naTitle: isNum(m.cmp) && m.cmp === 0 ? t('deltaZeroBase') : t('deltaNa') })
        }</td></tr>`;
      })
      .join('');

    host.innerHTML = TTCollapse.html({
      id: 'period',
      title: esc(t('pcTitle')),
      meta: esc(t('pcMeta')),
      summary,
      cls: 'cx-period',
      body: `
        <div class="pc-cards">
          <div class="pc-card cur"><span>${esc(t('pcCur'))}</span><b>${esc(v.currentFrom)} ~ ${esc(v.currentTo)}</b><em>${esc(t('nDays', { n: pc.currentDays }))} · ${esc(t('videosN', { n: pc.current.n }))}</em></div>
          <div class="pc-vs">vs</div>
          <div class="pc-card cmp"><span>${esc(t('cmpMode_' + v.mode))}</span><b>${esc(v.compareFrom)} ~ ${esc(v.compareTo)}</b><em>${esc(t('nDays', { n: pc.compareDays }))} · ${esc(insufficient ? t('insufficientShort') : t('videosN', { n: pc.compare.n }))}</em></div>
        </div>
        <div class="notes">${notes.map(([k, s]) => `<div class="note ${k}">${esc(s)}</div>`).join('')}</div>
        <div class="tbl-wrap compact"><table class="data pc-table">
          <thead><tr><th>${esc(t('ecMetric'))}</th><th class="num">${esc(t('pcCur'))}</th><th class="num">${esc(t('pcCmp'))}</th><th class="num">${esc(t('diffAbs'))}</th><th class="num">${esc(t('diffPct'))}</th></tr></thead>
          <tbody>${rowsHtml}</tbody></table></div>`,
    });
  }

  /* ---------------- AI 经营简报 ---------------- */
  function aiBody(r) {
    if (!r) return `<div class="skeleton-lines"><i></i><i></i><i style="width:60%"></i></div><p class="fineprint">${esc(t('aiBriefWorking'))}</p>`;
    if (r.error) return `<div class="note err">${esc(r.error)}</div><button type="button" class="btn sm" data-ai-retry>${esc(t('retry'))}</button>`;
    return `<div class="ai-md">${esc(r.brief).replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</div>`;
  }
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
    host.innerHTML = TTCollapse.html({
      id: 'ai',
      open: true,
      title: esc(t('aiBriefTitle')),
      meta: esc(t('aiBriefMeta', { range: rangeText(state.job.currentFrom, state.job.currentTo) })),
      summary: r ? (r.error ? `<span class="err">${esc(t('aiFailedShort'))}</span>` : `<span class="muted">${esc(r.cached ? t('aiBriefCached') : t('aiBriefReady'))}</span>`) : `<span class="spinner xs"></span> <span class="muted">${esc(t('aiBriefWorkingShort'))}</span>`,
      extra: r && !r.error ? `<button type="button" class="btn xs ghost" data-ai-regen>${esc(t('aiBriefRegen'))}</button>` : '',
      body: aiBody(r),
    });
    if (!r) loadAi(jobId);
  }
  async function loadAi(jobId, force) {
    if (force) {
      aiCache.delete(jobId);
      try {
        await api(`/api/jobs/${encodeURIComponent(jobId)}/ai-brief`, { method: 'DELETE' });
      } catch (_) {}
      renderAi();
      return;
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

  /* ---------------- 总渲染 ---------------- */
  function render() {
    const has = !!state.job && state.rows.length > 0;
    $('#results').hidden = !has;
    $('#emptyState').hidden = has || state.busy || TTProgress.isRunning(state.job);
    if (!has) return;
    const rows = selectedRows();
    const ctx = compareContext(rows);
    renderHead();
    renderBanner();
    renderKpis(rows, ctx);
    renderAccounts();
    renderDaily(rows, ctx);
    renderCart(rows);
    renderPeriod(rows, ctx);
    renderAi();
    TTChart.mountAll($('#results'));
    renderCreator();
    TTTable.render();
  }

  /** 载入一个任务的结果（新抓完 / 打开历史） */
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

  /** 筛选条件变了：覆盖范围内直接用真实数据重算；超出则提示重新抓取 */
  function onFilter(snap) {
    if (!state.job || state.busy) return;
    const c = snap.compare;
    const want = {
      currentFrom: snap.from,
      currentTo: snap.to,
      compareFrom: c ? c.from : null,
      compareTo: c ? c.to : null,
      mode: c ? snap.mode : 'none',
      info: c || null,
    };
    if (sameView(want, state.view)) return;
    if (covered(want)) {
      state.view = want;
      state.mismatch = null;
      reclassify(want);
    } else {
      const lo = want.compareFrom && want.compareFrom < want.currentFrom ? want.compareFrom : want.currentFrom;
      const hi = want.compareTo && want.compareTo > want.currentTo ? want.compareTo : want.currentTo;
      state.mismatch = { lo, hi };
    }
    render();
  }

  function init() {
    TTFilter.onChange(onFilter);
    $('#results').addEventListener('click', (e) => {
      const acct = e.target.closest('[data-acct]');
      if (acct) {
        state.account = acct.dataset.acct;
        render();
        return;
      }
      const dm = e.target.closest('[data-daily]');
      if (dm) {
        prefs.set('dailyMetric', dm.dataset.daily);
        const rows = selectedRows();
        renderDaily(rows, compareContext(rows));
        TTChart.mountAll($('#chartDaily'));
        return;
      }
      const cm = e.target.closest('[data-cart]');
      if (cm) {
        prefs.set('cartMode', cm.dataset.cart);
        renderCart(selectedRows());
        return;
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
    // 账号切换用方向键（radiogroup 标准行为）
    $('#acctTabs').addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const btns = $$('#acctTabs [data-acct]');
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length].focus();
    });
  }

  return { init, load, render, selectedRows, refreshCreator: () => renderCreator(true) };
})();

/* ============================================================
   视频明细：期次切换 / 搜索 / 排序 / 详情展开 / 批量选择 / 下载 / 链接解析
   ============================================================ */
const TTTable = (() => {
  const tb = {
    period: 'current', // current | compare | all（只在有对比期时出现）
    search: '',
    refs: null, // 搜索框里识别出的视频链接 / vid
    sortKey: prefs.get('sortKey', 'views'),
    sortDir: prefs.get('sortDir', 'desc'),
    picking: false,
    picked: new Set(),
    expandAll: false,
  };

  /** 搜索框里是不是「视频链接 / 纯 vid」（必须整段都是，夹杂其它词就按文本搜索） */
  function parseRefs(raw) {
    const parts = String(raw || '').split(/[\s,;，；]+/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return [];
    const isLink = (s) => /^https?:\/\//i.test(s) || /(^|\.)(tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com)/i.test(s);
    const isVid = (s) => /^\d{15,22}$/.test(s);
    const hits = parts.filter((s) => isLink(s) || isVid(s));
    return hits.length === parts.length ? hits : [];
  }

  function visibleRows() {
    const hasCmp = !!(state.view && state.view.compareFrom);
    let rows = state.rows.filter((r) => state.account === '__all__' || r.account === state.account || r.fromLink);
    if (hasCmp && tb.period !== 'all') {
      rows = rows.filter((r) => r.fromLink || (tb.period === 'compare' ? TTMetrics.inCompare(r) : TTMetrics.inCurrent(r)));
    } else if (!hasCmp) rows = rows.filter((r) => r.fromLink || TTMetrics.inCurrent(r));
    if (tb.search) {
      const q = tb.search;
      rows = rows.filter(
        (r) =>
          (r.desc || '').toLowerCase().includes(q) ||
          (r.account || '').toLowerCase().includes(q) ||
          (r.tags || '').toLowerCase().includes(q) ||
          String(r.vid || '').includes(q)
      );
    }
    const k = tb.sortKey;
    const dir = tb.sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      // 没有数据的行（链接解析进来的）永远排在最后，不和真实的 0 混在一起
      const va = a[k], vb = b[k];
      const na = va === null || va === undefined, nb = vb === null || vb === undefined;
      if (na || nb) return na === nb ? 0 : na ? 1 : -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  function periodBadge(r) {
    if (!state.view || !state.view.compareFrom || r.fromLink) return '';
    if (r.inCurrent && r.inCompare) return `<span class="tag sm">${esc(t('periodBoth'))}</span>`;
    if (r.inCompare) return `<span class="tag sm cmp">${esc(t('pcCmp'))}</span>`;
    return '';
  }

  function rowHtml(r, i) {
    const picked = tb.picked.has(String(r.vid));
    const cover = r.cover
      ? `<img class="row-cover" src="${esc(r.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
      : `<div class="row-cover empty-cover" aria-hidden="true">▶</div>`;
    const sub = [];
    if (r.duration) sub.push(r.duration + 's');
    if (state.account === '__all__' && r.account) sub.push('@' + r.account);
    const n = (v) => (v === null || v === undefined ? `<span class="muted">${DASH}</span>` : fmtInt(v));
    return `<tr data-vid="${esc(r.vid)}" tabindex="0" aria-expanded="false">
      <td class="ctr pick-col"><input type="checkbox" class="row-pick" data-vid="${esc(r.vid)}"${picked ? ' checked' : ''} aria-label="select"></td>
      <td class="num muted">${i + 1}</td>
      <td class="ctr cover-col">${cover}</td>
      <td class="desc"><div class="d">${esc(r.desc) || `<span class="muted">${esc(t('noCaption'))}</span>`}</div>
        <div class="sub-line">${esc(sub.join(' · '))} ${periodBadge(r)}${r.fromLink ? `<span class="tag sm">${esc(t('fromLink'))}</span>` : ''}</div></td>
      <td class="date-col"><div class="dt">${esc(r.date || DASH)}</div>${r.time ? `<div class="dt-t">${esc(r.time)}</div>` : ''}</td>
      <td class="num strong">${n(r.views)}</td>
      <td class="num">${n(r.likes)}</td>
      <td class="num">${n(r.comments)}</td>
      <td class="num">${n(r.shares)}</td>
      <td class="num">${n(r.saves)}</td>
      <td class="num">${r.inter === null || r.inter === undefined ? `<span class="muted">${DASH}</span>` : fmtPct(r.inter)}</td>
      <td class="ctr">${r.isEC ? `<span class="tag sm ec">${esc(t('yesShort'))}</span>` : `<span class="muted">${DASH}</span>`}</td>
      <td class="ctr"><button type="button" class="icon-btn sm row-dl" data-vid="${esc(r.vid)}" title="${esc(t('colDownload'))}" aria-label="${esc(t('colDownload'))}">⤓</button></td>
    </tr>`;
  }

  function render() {
    const host = $('#rows');
    if (!host) return;
    const hasCmp = !!(state.view && state.view.compareFrom);
    const seg = $('#periodSeg');
    if (!hasCmp && tb.period !== 'current') tb.period = 'current';
    seg.hidden = !hasCmp;
    if (hasCmp) {
      const cnt = (p) =>
        state.rows.filter((r) => !r.fromLink && (state.account === '__all__' || r.account === state.account) && (p === 'all' || (p === 'compare' ? TTMetrics.inCompare(r) : TTMetrics.inCurrent(r)))).length;
      seg.innerHTML = ['current', 'compare', 'all']
        .map((p) => `<button type="button" role="radio" data-period="${p}" aria-checked="${tb.period === p}" class="${tb.period === p ? 'on' : ''}">${esc(t('tp_' + p))} <span class="muted">${cnt(p)}</span></button>`)
        .join('');
    }
    const rows = visibleRows();
    host.innerHTML = rows.length
      ? rows.map(rowHtml).join('')
      : `<tr class="empty-row"><td colspan="13"><div class="chart-empty">${esc(tb.search ? t('noMatch') : t('noVideosInRange'))}</div></td></tr>`;
    setExpandAll(false);
    $$('thead th[data-sort]').forEach((th) => {
      const on = th.dataset.sort === tb.sortKey;
      th.classList.toggle('on', on);
      th.setAttribute('aria-sort', on ? (tb.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
      const ar = th.querySelector('.ar');
      if (ar) ar.textContent = on ? (tb.sortDir === 'desc' ? '▼' : '▲') : '';
    });
    const all = $('#rowSelAll');
    if (all) all.checked = rows.length > 0 && rows.every((r) => tb.picked.has(String(r.vid)));
    $('#tableMeta').textContent = t('tableMeta', { n: rows.length, by: t('sortBy_' + tb.sortKey) });
    updatePickCount();
  }

  /* ---------------- 详情（行点击展开） ---------------- */
  const TREND_METRICS = [
    { key: 'views', label: 'colViews', src: 'tiktok', unit: 'unitViews' },
    { key: 'likes', label: 'colLikes', src: 'tiktok', unit: 'unitCount' },
    { key: 'comments', label: 'colComments', src: 'tiktok', unit: 'unitCount' },
    { key: 'shares', label: 'colShares', src: 'tiktok', unit: 'unitCount' },
    { key: 'completionRate', label: 'sfFinish', src: 'seller', unit: 'unitPct', pct: true },
    { key: 'ctr', label: 'sfCtr', src: 'seller', unit: 'unitPct', pct: true },
    { key: 'productClicks', label: 'sfClicks', src: 'seller', unit: 'unitCount' },
    { key: 'newFans', label: 'sfNewFans', src: 'seller', unit: 'unitPeople' },
  ];
  const srcName = (s) => t(s === 'seller' ? 'trendSrcSeller' : s === 'creator' ? 'trendSrcCreator' : 'trendSrcTiktok');

  /** 单条视频的历史快照趋势：每个指标一张独立量纲的可折叠小图（绝不把不同量纲塞进同一纵轴） */
  async function renderTrend(el, r) {
    el.innerHTML = `<div class="inline-loading"><span class="spinner xs"></span>${esc(t('trendLoading'))}</div>`;
    let v = null;
    try {
      v = await jget('/api/videos/' + encodeURIComponent(r.vid));
    } catch (e) {
      if (e.status !== 404) {
        el.innerHTML = `<div class="note err">${esc(e.message)}</div>`;
        return;
      }
    }
    const h = (v && v.history) || [];
    const items = [];
    for (const m of TREND_METRICS) {
      const pts = h.filter((p) => isNum(p[m.key])).map((p) => ({ x: shortDate(p.date), label: p.date, v: m.pct && p[m.key] > 1 ? p[m.key] / 100 : p[m.key] }));
      if (!pts.length) continue;
      const a = pts[0].v, b = pts[pts.length - 1].v;
      const d = TTMetrics.delta(b, a);
      items.push(
        TTCollapse.html({
          id: 'vtrend:' + m.key,
          variant: 'item',
          title: esc(t(m.label)),
          meta: esc(`${srcName(m.src)} · ${t('snapN', { n: pts.length })}`),
          summary:
            pts.length >= 2
              ? `${esc(m.pct ? fmtPct(a, 1) : fmtCompact(a))} → <b>${esc(m.pct ? fmtPct(b, 1) : fmtCompact(b))}</b> ${deltaChip(d.pct)}`
              : `<b>${esc(m.pct ? fmtPct(a, 1) : fmtCompact(a))}</b> <span class="muted">${esc(t('chartSinglePointShort'))}</span>`,
          body: TTChart.placeholder({ series: [{ name: t(m.label), points: pts }], unit: t(m.unit), kind: m.pct ? 'pct' : 'int', height: 150 }),
        })
      );
    }
    const first = h[0] && h[0].date, last = h[h.length - 1] && h[h.length - 1].date;
    el.innerHTML = `<div class="trend-head"><b>${esc(t('trendTitle'))}</b><span class="muted">${esc(t('snapN', { n: h.length }))}${first && last ? ` · ${esc(first)} ~ ${esc(last)}` : ''}</span></div>
      ${items.length ? `<div class="cx-stack">${items.join('')}</div>` : `<div class="chart-empty">${esc(t('trendNone'))}</div>`}
      ${items.length && h.length < 2 ? `<p class="fineprint">${esc(t('trendOnlyOne'))}</p>` : ''}`;
    TTChart.mountAll(el);
  }

  function buildDetailRow(r, withMedia) {
    const d = document.createElement('tr');
    d.className = 'd-tr';
    const sf = [];
    if (r.gmv !== undefined) sf.push([t('sfGmv'), fmtInt(r.gmv)]);
    if (r.orders !== undefined) sf.push([t('sfOrders'), fmtInt(r.orders)]);
    if (r.productClicks !== undefined) sf.push([t('sfClicks'), fmtInt(r.productClicks)]);
    if (r.gpm !== undefined) sf.push([t('sfGpm'), fmtInt(r.gpm)]);
    if (r.finishRate !== undefined) sf.push([t('sfFinish'), r.finishRate + '%']);
    if (r.completionRate !== undefined) sf.push([t('sfFinish'), r.completionRate + '%']);
    if (r.avgWatchTime !== undefined) sf.push([t('sfWatch'), r.avgWatchTime + 's']);
    if (r.newFans !== undefined) sf.push([t('sfNewFans'), fmtInt(r.newFans)]);
    if (r.ctr !== undefined) sf.push([t('sfCtr'), r.ctr + '%']);
    const yes = (b) => (b ? t('yesShort') : DASH);
    const fields = [
      [t('dVid'), r.vid],
      [t('colAccount'), '@' + (r.account || '')],
      [t('dPublished'), `${r.date || DASH} ${r.time || ''}`],
      [t('colDuration'), r.duration ? r.duration + 's' : DASH],
      [t('dCore'), `${fmtInt(r.views)} / ${fmtInt(r.likes)} / ${fmtInt(r.comments)}`],
      [t('dMore'), `${fmtInt(r.shares)} / ${fmtInt(r.saves)} / ${fmtInt(r.reposts)}`],
      [t('colEngage'), fmtPct(r.inter)],
      [t('colShopping'), yes(r.isEC)],
      [t('dAd'), yes(r.isAd)],
      ['AIGC', yes(r.isAIGC)],
      [t('dLang'), r.lang || DASH],
      [t('dMusic'), r.music || DASH],
      ...sf,
    ];
    d.innerHTML = `<td colspan="13"><div class="d-detail">
      <div class="d-grid">${fields.map(([k, v]) => `<div><span class="dk">${esc(k)}</span><span class="dv">${esc(v)}</span></div>`).join('')}
        <div><span class="dk">${esc(t('dLink'))}</span><span class="dv"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(t('colOpen'))}</a></span></div>
      </div>
      ${withMedia ? `<div class="d-media">
        <div class="d-player-box"><video class="d-video" controls playsinline preload="metadata" poster="${esc(r.cover || '')}"></video></div>
        <div class="d-side">
          <div class="d-player-note"><span class="spinner xs"></span> ${esc(t('playerLoading'))}</div>
          ${state.aiConfigured ? `<button type="button" class="btn sm d-ai" data-vid="${esc(r.vid)}">${esc(t('aiOneVideo'))}</button>` : ''}
          <div class="d-out"></div>
        </div>
      </div>` : ''}
      <div class="d-hist"></div></div></td>`;
    return d;
  }

  async function embedPlay(r, d) {
    const note = d.querySelector('.d-player-note');
    try {
      const res = await jpost('/api/video-download/play-url', { url: r.url, vid: r.vid });
      const v = d.querySelector('video');
      v.src = res.playUrl;
      if (res.cover) v.poster = res.cover;
      note.textContent = `${res.duration || r.duration}s · ${t('playerNoWatermark')}`;
    } catch (e) {
      note.innerHTML = `<span class="err">${esc(e.message)}</span>`;
    }
  }

  async function hydrate(r, d, withMedia) {
    if (withMedia && r.url) embedPlay(r, d);
    const el = d.querySelector('.d-hist');
    if (el && !r.fromLink) await renderTrend(el, r).catch(() => (el.innerHTML = ''));
  }

  function toggleRow(tr) {
    const host = $('#rows');
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('d-tr')) {
      next.remove();
      tr.setAttribute('aria-expanded', 'false');
      setExpandAll(false);
      return;
    }
    host.querySelectorAll('.d-tr').forEach((x) => {
      if (x.previousElementSibling) x.previousElementSibling.setAttribute('aria-expanded', 'false');
      x.remove();
    });
    setExpandAll(false);
    const r = state.rows.find((x) => String(x.vid) === String(tr.dataset.vid));
    if (!r) return;
    const d = buildDetailRow(r, true);
    tr.after(d);
    tr.setAttribute('aria-expanded', 'true');
    hydrate(r, d, true);
  }

  function setExpandAll(on) {
    tb.expandAll = !!on;
    const b = $('#expandAllBtn');
    if (!b) return;
    b.classList.toggle('on', tb.expandAll);
    b.textContent = tb.expandAll ? t('collapseAll') : t('expandAll');
  }

  /* ---------------- 勾选 / 批量下载 ---------------- */
  function setPicking(on) {
    tb.picking = !!on;
    if (!on) tb.picked.clear();
    document.body.classList.toggle('picking', tb.picking);
    $('#pickBar').hidden = !tb.picking;
    $('#dlBatchBtn').classList.toggle('on', tb.picking);
    render();
  }
  function updatePickCount() {
    const n = $('#pickCount');
    if (n) n.textContent = tb.picked.size ? t('dlPicked', { n: tb.picked.size }) : t('dlPick');
    const go = $('#dlPickGo');
    if (go) go.disabled = !tb.picked.size;
  }

  /* ---------------- 下载（共用的进度轮询） ----------------
     有总数时显示真实的「已完成 x / 共 y」；在按钮上转圈，不盖整个页面。 */
  function pollDl(jobId, total, btn, onDone) {
    const done = btnBusy(btn, t('dlProgress', { done: 0, total: total || '?' }));
    let fails = 0;
    const timer = setInterval(async () => {
      let job;
      try {
        job = await jget(`/api/video-download/jobs/${jobId}`);
        fails = 0;
      } catch (e) {
        if (++fails >= 8) {
          clearInterval(timer);
          done();
          toast(e.message, 'err');
        }
        return;
      }
      const n = (job.files || []).length + (job.errors || []).length;
      if (btn) {
        const lbl = btn.querySelector('span:last-child');
        if (lbl) lbl.textContent = t('dlProgress', { done: n, total: total || '?' });
      }
      if (job.status === 'done' || job.status === 'error') {
        clearInterval(timer);
        done();
        onDone(job);
      }
    }, 1200);
  }
  function dlToast(job) {
    const ok = (job.files || []).length;
    const bad = (job.errors || []).length;
    toast(t('dlFinished', { ok, bad }) + (bad ? ' · ' + job.errors[0] : ''), ok ? 'ok' : 'err');
  }

  async function downloadOne(vid, btn) {
    const r = state.rows.find((x) => String(x.vid) === String(vid));
    if (!r) return;
    const done = btnBusy(btn, '');
    try {
      let item = { vid: r.vid, url: r.url, desc: r.desc, account: r.account, playUrl: r.playUrl };
      if (!item.playUrl) {
        const rs = await jpost('/api/video-download/resolve', { mode: 'urls', input: r.url });
        if (!rs.items || !rs.items.length) throw new Error((rs.errors || []).join('; ') || t('noPlayUrl'));
        item = rs.items[0];
      }
      const res = await jpost('/api/video-download/fetch', { items: [item], quality: 'best' });
      done();
      pollDl(res.jobId, 1, btn, dlToast);
    } catch (e) {
      done();
      toast(e.message, 'err');
    }
  }

  /** 账号卡片 ⤓：按当前本期日期范围下载该账号主页视频 */
  async function downloadHandle(handle, btn) {
    const h = String(handle || '').replace(/^@/, '');
    if (!h || !state.view) return;
    const done = btnBusy(btn, '');
    try {
      const rs = await jpost('/api/video-download/resolve', { mode: 'handle', input: h, from: state.view.currentFrom, to: state.view.currentTo });
      if (!rs.items || !rs.items.length) throw new Error(t('noData'));
      const res = await jpost('/api/video-download/fetch', { items: rs.items, quality: 'best' });
      done();
      pollDl(res.jobId, rs.items.length, btn, dlToast);
    } catch (e) {
      done();
      toast(e.message, 'err');
    }
  }

  async function downloadPicked(btn) {
    const rows = state.rows.filter((r) => tb.picked.has(String(r.vid)));
    if (!rows.length) return toast(t('dlPick'), 'err');
    const done = btnBusy(btn, '');
    try {
      const res = await jpost('/api/video-download/fetch', {
        items: rows.map((r) => ({ vid: r.vid, url: r.url, desc: r.desc, account: r.account, playUrl: r.playUrl })),
        quality: 'best',
      });
      done();
      setPicking(false);
      pollDl(res.jobId, rows.length, $('#dlBatchBtn'), dlToast);
    } catch (e) {
      done();
      toast(e.message, 'err');
    }
  }

  /** 搜索框粘贴链接 / vid → 解析后直接进入明细表（解析接口不给播放量，相关列显示「—」，不伪造数字） */
  async function resolveRefs(refs) {
    const btn = $('#searchGo');
    const done = btnBusy(btn, '');
    const hint = $('#searchHint');
    try {
      const rs = await jpost('/api/video-download/resolve', { mode: 'urls', input: refs.join(' ') });
      const items = rs.items || [];
      if (!items.length) throw new Error((rs.errors || []).join('; ') || t('noData'));
      const known = new Set(state.rows.map((r) => String(r.vid)));
      const fresh = items
        .filter((it) => it.vid && !known.has(String(it.vid)))
        .map((it) => {
          const ts = Number(it.createTime || 0) * 1000;
          const d = ts ? new Date(ts + 7 * 3600 * 1000).toISOString() : '';
          return {
            vid: String(it.vid), account: it.author || it.account || 'link',
            date: d ? d.slice(0, 10) : '', time: d ? d.slice(11, 16) : '', desc: it.desc || '',
            views: null, likes: null, comments: null, shares: null, saves: null, reposts: null, inter: null,
            duration: it.duration || 0, isEC: false, url: it.url || '', cover: it.cover || '', playUrl: it.playUrl || '',
            fromLink: true,
          };
        });
      if (!fresh.length) throw new Error(t('dlAlreadyThere'));
      state.rows = fresh.concat(state.rows);
      $('#search').value = '';
      tb.search = '';
      tb.refs = null;
      hint.hidden = true;
      render();
      toast(t('dlAddedRows', { n: fresh.length }), 'ok');
    } catch (e) {
      hint.textContent = e.message;
      hint.hidden = false;
      toast(e.message, 'err');
    } finally {
      done();
    }
  }

  async function aiOne(vid, btn) {
    const out = btn.closest('.d-side').querySelector('.d-out');
    const done = btnBusy(btn, t('aiWorking'));
    out.innerHTML = '';
    try {
      const r = await jpost('/api/ai/video', { vid });
      out.innerHTML = '<div class="ai-md">' + esc(r.analysis).replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/\n/g, '<br>') + '</div>';
    } catch (e) {
      out.innerHTML = `<div class="note err">${esc(e.message)}</div>`;
    } finally {
      done();
    }
  }

  function init() {
    $('#search').addEventListener('input', (e) => {
      const raw = e.target.value.trim();
      const refs = parseRefs(raw);
      const hint = $('#searchHint');
      if (refs.length) {
        tb.search = '';
        tb.refs = refs;
        hint.textContent = t('searchLinkHint', { n: refs.length });
        hint.hidden = false;
        $('#searchGo').hidden = false;
      } else {
        tb.refs = null;
        tb.search = raw.toLowerCase();
        hint.hidden = true;
        $('#searchGo').hidden = true;
      }
      render();
    });
    $('#search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && tb.refs && tb.refs.length) {
        e.preventDefault();
        resolveRefs(tb.refs);
      }
    });
    $('#searchGo').addEventListener('click', () => tb.refs && resolveRefs(tb.refs));

    $('#periodSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-period]');
      if (!b) return;
      tb.period = b.dataset.period;
      render();
    });

    $$('thead th[data-sort]').forEach((th) => {
      const sort = () => {
        if (tb.sortKey === th.dataset.sort) tb.sortDir = tb.sortDir === 'desc' ? 'asc' : 'desc';
        else {
          tb.sortKey = th.dataset.sort;
          tb.sortDir = th.dataset.sort === 'date' ? 'asc' : 'desc';
        }
        prefs.set('sortKey', tb.sortKey);
        prefs.set('sortDir', tb.sortDir);
        render();
      };
      th.tabIndex = 0;
      th.addEventListener('click', sort);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          sort();
        }
      });
    });

    const rows = $('#rows');
    rows.addEventListener('click', (e) => {
      const dl = e.target.closest('.row-dl');
      if (dl) {
        e.stopPropagation();
        return downloadOne(dl.dataset.vid, dl);
      }
      const ai = e.target.closest('.d-ai');
      if (ai) return aiOne(ai.dataset.vid, ai);
      if (e.target.closest('.row-pick') || e.target.closest('a')) return;
      const tr = e.target.closest('tr');
      if (!tr || tr.parentElement !== rows || tr.classList.contains('d-tr') || !tr.dataset.vid) return;
      toggleRow(tr);
    });
    rows.addEventListener('keydown', (e) => {
      const tr = e.target;
      if ((e.key === 'Enter' || e.key === ' ') && tr.tagName === 'TR' && tr.dataset.vid) {
        e.preventDefault();
        toggleRow(tr);
      }
    });
    rows.addEventListener('change', (e) => {
      const c = e.target.closest('.row-pick');
      if (!c) return;
      if (!tb.picking) setPicking(true);
      if (c.checked) tb.picked.add(String(c.dataset.vid));
      else tb.picked.delete(String(c.dataset.vid));
      updatePickCount();
    });
    $('#rowSelAll').addEventListener('change', (e) => {
      const vis = visibleRows();
      if (e.target.checked) vis.forEach((r) => tb.picked.add(String(r.vid)));
      else vis.forEach((r) => tb.picked.delete(String(r.vid)));
      render();
    });

    $('#expandAllBtn').addEventListener('click', () => {
      const host = $('#rows');
      if (tb.expandAll) {
        host.querySelectorAll('.d-tr').forEach((x) => x.remove());
        host.querySelectorAll('tr[aria-expanded="true"]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
        return setExpandAll(false);
      }
      // 批量展开只看数据，不开播放器（几十个 <video> 会把内存和流量打爆）
      const trs = [...host.querySelectorAll('tr[data-vid]')];
      trs.forEach((tr, i) => {
        if (tr.nextElementSibling && tr.nextElementSibling.classList.contains('d-tr')) return;
        const r = state.rows.find((x) => String(x.vid) === String(tr.dataset.vid));
        if (!r) return;
        const d = buildDetailRow(r, false);
        tr.after(d);
        tr.setAttribute('aria-expanded', 'true');
        setTimeout(() => hydrate(r, d, false), i * 40);
      });
      setExpandAll(true);
    });

    $('#dlBatchBtn').addEventListener('click', () => setPicking(!tb.picking));
    $('#dlPickCancel').addEventListener('click', () => setPicking(false));
    $('#dlPickGo').addEventListener('click', (e) => downloadPicked(e.currentTarget));
  }

  function reset() {
    tb.picked.clear();
    tb.search = '';
    tb.refs = null;
    const s = $('#search');
    if (s) s.value = '';
  }

  return { init, render, reset, downloadHandle };
})();

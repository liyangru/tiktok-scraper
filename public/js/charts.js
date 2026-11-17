/* ============================================================
   图表：纯 SVG / CSS，零依赖（离线可用，不走 CDN）

   TTChart.line(el, spec)   折线：按容器真实宽度绘制，宽度变化自动重绘
     spec = {
       series: [{ name, tone: 'cur'|'cmp'|'alt', dashed, points: [{ x: '11-10', label: '2026-11-10', v: number|null, note }] }],
       unit:    纵轴单位（显示在左上角，如「播放（次）」）
       kind:    'int' | 'pct' | 'dec'（决定刻度与提示框格式）
       height:  默认 200；compact 模式默认 72
       compact: 迷你图：不画网格与纵轴刻度，只保留首尾日期和最高值
       empty:   没有数据时的提示
     }
     · null = 没有数据：折线在这里断开，绝不当成 0 画下去
     · 只有一个有效点：只画这个点并说明「无法形成趋势」，不连成假趋势
   TTChart.pairBars(rows, opts)  挂车 vs 非挂车之类的成对横条（每行独立比例尺，数值比例准确）
   ============================================================ */
const TTChart = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  let ro = null;
  const tip = () => {
    let el = document.getElementById('chartTip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chartTip';
      el.className = 'chart-tip';
      el.setAttribute('role', 'tooltip');
      document.body.appendChild(el);
    }
    return el;
  };

  function fmtV(v, kind) {
    if (!isNum(v)) return t('noDataShort');
    if (kind === 'pct') return fmtPct(v);
    if (kind === 'dec') return fmtDec(v, 1);
    return fmtInt(v);
  }
  function fmtTick(v, kind) {
    if (kind === 'pct') return (v * 100).toFixed(v * 100 < 10 && v !== 0 ? 1 : 0) + '%';
    return fmtCompact(v);
  }

  /** 「好看」的刻度：1 / 2 / 2.5 / 5 × 10^n */
  function niceTicks(min, max, count) {
    if (min === max) {
      const pad = Math.abs(max) * 0.5 || 1;
      min = Math.max(0, min - pad);
      max = max + pad;
    }
    const raw = (max - min) / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
    return { lo, hi, ticks };
  }

  function draw(el) {
    const spec = el._chart;
    if (!spec) return;
    const width = Math.max(160, Math.round(el.clientWidth || el.getBoundingClientRect().width || 560));
    if (el._drawnWidth === width && el._drawnSpec === spec) return;
    el._drawnWidth = width;
    el._drawnSpec = spec;

    const compact = !!spec.compact;
    const H = spec.height || (compact ? 72 : 200);
    const kind = spec.kind || 'int';
    const series = (spec.series || []).filter((s) => s && Array.isArray(s.points));
    const allVals = [];
    series.forEach((s) => s.points.forEach((p) => isNum(p.v) && allVals.push(p.v)));
    const n = Math.max(0, ...series.map((s) => s.points.length));

    if (!allVals.length || !n) {
      el.innerHTML = `<div class="chart-empty">${esc(spec.empty || t('chartEmpty'))}</div>`;
      return;
    }

    const pad = compact ? { l: 4, r: 4, t: 14, b: 16 } : { l: 52, r: 16, t: 26, b: 28 };
    const iw = width - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const nonNeg = allVals.every((v) => v >= 0);
    const vmin = nonNeg ? 0 : Math.min(...allVals);
    const { lo, hi, ticks } = niceTicks(vmin, Math.max(...allVals), compact ? 2 : 4);
    const span = hi - lo || 1;
    const X = (i) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const Y = (v) => pad.t + ih - ((v - lo) / span) * ih;

    const parts = [];
    // 网格 + 纵轴刻度
    if (!compact) {
      ticks.forEach((tv) => {
        const y = Y(tv).toFixed(1);
        parts.push(`<line class="ch-grid" x1="${pad.l}" x2="${width - pad.r}" y1="${y}" y2="${y}"/>`);
        parts.push(`<text class="ch-ytick" x="${pad.l - 8}" y="${(+y + 3.5).toFixed(1)}" text-anchor="end">${esc(fmtTick(tv, kind))}</text>`);
      });
      if (spec.unit) parts.push(`<text class="ch-unit" x="${pad.l}" y="12">${esc(spec.unit)}</text>`);
    } else {
      parts.push(`<line class="ch-base" x1="${pad.l}" x2="${width - pad.r}" y1="${pad.t + ih}" y2="${pad.t + ih}"/>`);
    }

    // 横轴日期：按可用宽度挑均匀间隔的几个，首尾必出，绝不重叠
    const ref = series[0].points;
    const labelW = compact ? 44 : 52;
    const maxLabels = Math.max(2, Math.floor(iw / labelW));
    const step = Math.max(1, Math.ceil((n - 1) / (maxLabels - 1)));
    const idx = [];
    if (n === 1) idx.push(0);
    else {
      for (let i = 0; i < n; i += step) idx.push(i);
      if (idx[idx.length - 1] !== n - 1) {
        if (n - 1 - idx[idx.length - 1] < step * 0.6) idx.pop();
        idx.push(n - 1);
      }
    }
    idx.forEach((i) => {
      const p = ref[i];
      if (!p) return;
      const anchor = n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      parts.push(`<text class="ch-xtick" x="${X(i).toFixed(1)}" y="${H - (compact ? 3 : 8)}" text-anchor="${anchor}">${esc(p.x)}</text>`);
    });

    // 折线：遇到 null 断开
    let validCount = 0;
    series.forEach((s, si) => {
      const tone = s.tone || (si === 0 ? 'cur' : 'cmp');
      let d = '';
      let pen = false;
      let area = '';
      let segStart = null;
      s.points.forEach((p, i) => {
        if (!isNum(p.v)) {
          if (pen && si === 0 && segStart !== null) area += ` L ${X(i - 1).toFixed(1)} ${pad.t + ih} L ${X(segStart).toFixed(1)} ${pad.t + ih} Z`;
          pen = false;
          segStart = null;
          return;
        }
        if (si === 0) validCount++;
        const cmd = pen ? 'L' : 'M';
        d += ` ${cmd} ${X(i).toFixed(1)} ${Y(p.v).toFixed(1)}`;
        if (si === 0) {
          if (!pen) {
            segStart = i;
            area += ` M ${X(i).toFixed(1)} ${pad.t + ih} L ${X(i).toFixed(1)} ${Y(p.v).toFixed(1)}`;
          } else area += ` L ${X(i).toFixed(1)} ${Y(p.v).toFixed(1)}`;
        }
        pen = true;
      });
      if (pen && si === 0 && segStart !== null) {
        const last = s.points.length - 1;
        area += ` L ${X(last).toFixed(1)} ${pad.t + ih} L ${X(segStart).toFixed(1)} ${pad.t + ih} Z`;
      }
      if (si === 0 && area && !compact) parts.push(`<path class="ch-area tone-${tone}" d="${area}"/>`);
      if (d) parts.push(`<path class="ch-line tone-${tone}${s.dashed ? ' dashed' : ''}" d="${d}"/>`);
      // 孤立点（前后都是 null）画成小圆点，否则一条线段都没有就看不见
      s.points.forEach((p, i) => {
        if (!isNum(p.v)) return;
        const prev = s.points[i - 1], next = s.points[i + 1];
        const lonely = !(prev && isNum(prev.v)) && !(next && isNum(next.v));
        if (lonely) parts.push(`<circle class="ch-dot tone-${tone}" cx="${X(i).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="3"/>`);
      });
    });

    // 迷你图：标出最高值
    if (compact) {
      const s0 = series[0].points;
      let mi = -1;
      s0.forEach((p, i) => { if (isNum(p.v) && (mi < 0 || p.v > s0[mi].v)) mi = i; });
      if (mi >= 0) {
        const x = X(mi), y = Y(s0[mi].v);
        const anchor = x < 30 ? 'start' : x > width - 30 ? 'end' : 'middle';
        parts.push(`<text class="ch-peak" x="${x.toFixed(1)}" y="${Math.max(10, y - 4).toFixed(1)}" text-anchor="${anchor}">${esc(fmtTick(s0[mi].v, kind))}</text>`);
      }
    }

    // 悬停辅助线 + 高亮点（由 mousemove 定位）
    parts.push(`<line class="ch-guide" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" style="display:none"/>`);
    series.forEach((s, si) => parts.push(`<circle class="ch-hot tone-${s.tone || (si === 0 ? 'cur' : 'cmp')}" r="4" style="display:none"/>`));
    parts.push(`<rect class="ch-hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}"/>`);

    const legend =
      series.length > 1 && !compact
        ? `<div class="ch-legend">${series
            .map((s, si) => `<span class="lg tone-${s.tone || (si === 0 ? 'cur' : 'cmp')}${s.dashed ? ' dashed' : ''}"><i></i>${esc(s.name || '')}</span>`)
            .join('')}</div>`
        : '';
    const single = validCount === 1 && !compact ? `<div class="chart-note">${esc(t('chartSinglePoint'))}</div>` : '';

    el.innerHTML = `${legend}<svg class="ch" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" role="img" aria-label="${esc(spec.aria || spec.unit || '')}">${parts.join('')}</svg>${single}`;

    const svg = el.querySelector('svg');
    const guide = svg.querySelector('.ch-guide');
    const hots = [...svg.querySelectorAll('.ch-hot')];
    const hit = svg.querySelector('.ch-hit');
    const show = (ev) => {
      const rect = svg.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((x - pad.l) / iw) * (n - 1))));
      guide.setAttribute('x1', X(i));
      guide.setAttribute('x2', X(i));
      guide.style.display = '';
      const lines = [];
      series.forEach((s, si) => {
        const p = s.points[i];
        const h = hots[si];
        if (p && isNum(p.v)) {
          h.setAttribute('cx', X(i));
          h.setAttribute('cy', Y(p.v));
          h.style.display = '';
        } else h.style.display = 'none';
        if (!p) return;
        const name = series.length > 1 ? `<span class="tt-sw tone-${s.tone || (si === 0 ? 'cur' : 'cmp')}"></span>${esc(s.name || '')} · ` : '';
        lines.push(`<div class="tt-row">${name}<span class="tt-date">${esc(p.label || p.x)}</span><b>${esc(fmtV(p.v, kind))}</b>${p.note ? `<span class="tt-note">${esc(p.note)}</span>` : ''}</div>`);
      });
      const tp = tip();
      tp.innerHTML = lines.join('');
      tp.classList.add('show');
      const tw = tp.offsetWidth, th = tp.offsetHeight;
      let left = ev.clientX + 14;
      if (left + tw > window.innerWidth - 8) left = ev.clientX - tw - 14;
      let top = ev.clientY - th - 12;
      if (top < 8) top = ev.clientY + 16;
      tp.style.left = left + 'px';
      tp.style.top = top + 'px';
    };
    const hide = () => {
      guide.style.display = 'none';
      hots.forEach((h) => (h.style.display = 'none'));
      tip().classList.remove('show');
    };
    hit.addEventListener('mousemove', show);
    hit.addEventListener('mouseleave', hide);
  }

  function observe(el) {
    if (!('ResizeObserver' in window)) return;
    if (!ro) {
      ro = new ResizeObserver((entries) => {
        requestAnimationFrame(() => entries.forEach((e) => e.target.isConnected && draw(e.target)));
      });
    }
    ro.observe(el);
  }

  function line(el, spec) {
    if (!el) return;
    el.classList.add('chart');
    el._chart = spec;
    el._drawnWidth = 0;
    draw(el);
    observe(el);
  }

  /** 先输出占位 HTML，挂到页面后再调用 mountAll() 统一绘制（避免拼 HTML 时拿不到宽度） */
  const pending = new Map();
  let seq = 0;
  function placeholder(spec, cls) {
    const id = 'ch' + ++seq;
    pending.set(id, spec);
    return `<div class="chart${cls ? ' ' + cls : ''}" data-chart-id="${id}"></div>`;
  }
  function mountAll(root = document) {
    root.querySelectorAll('[data-chart-id]').forEach((el) => {
      const spec = pending.get(el.dataset.chartId);
      if (!spec) return;
      pending.delete(el.dataset.chartId);
      line(el, spec);
    });
  }

  /**
   * 成对横条。rows: [{ label, a, b, kind, aNote, bNote }]
   * 每一行用该行 max(a, b) 作比例尺：长度比例 = 数值比例。没有数据的一侧显示「无数据」，不画 0 长度假条。
   */
  function pairBars(rows, opts = {}) {
    return `<div class="pair-bars">
      <div class="pb-legend"><span class="lg tone-a"><i></i>${esc(opts.aName || 'A')}</span><span class="lg tone-b"><i></i>${esc(opts.bName || 'B')}</span></div>
      ${rows
        .map((r) => {
          const max = Math.max(isNum(r.a) ? r.a : 0, isNum(r.b) ? r.b : 0);
          const w = (v) => (isNum(v) && max > 0 ? Math.max(0.5, (v / max) * 100) : 0);
          const bar = (v, tone, note) =>
            `<div class="pb-bar tone-${tone}">${
              isNum(v) ? `<i style="width:${w(v).toFixed(2)}%"></i>` : ''
            }<span class="pb-val">${isNum(v) ? esc(fmtKind(v, r.kind)) : `<em>${esc(t('noDataShort'))}</em>`}${note ? `<small>${esc(note)}</small>` : ''}</span></div>`;
          return `<div class="pb-row"><div class="pb-label">${esc(r.label)}</div><div class="pb-bars">${bar(r.a, 'a', r.aNote)}${bar(r.b, 'b', r.bNote)}</div><div class="pb-delta">${r.delta || ''}</div></div>`;
        })
        .join('')}
    </div>`;
  }

  return { line, placeholder, mountAll, pairBars, niceTicks };
})();

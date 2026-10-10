/* 品牌媒体分析 —— 前端面板 */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => (n === null || n === undefined || n === '' ? '-' : Number(n).toLocaleString('en-US'));
  const pct = (n) => (n === null || n === undefined ? '-' : (n * 100).toFixed(2) + '%');

  function mount(root, ctx) {
    const t = ctx.t;
    root.innerHTML = `
      <div class="ba-edit">
        <div class="ba-groups" id="baGroups"></div>
        <div class="si-row">
          <input id="baName" class="si-select" placeholder="${esc(t('baBrandName'))}" style="max-width:180px">
          <input id="baHandles" class="si-select" placeholder="${esc(t('baHandlesHint'))}" style="flex:1;min-width:240px">
          <button id="baAdd" class="btn-like">${esc(t('baAdd'))}</button>
          <button id="baSave" class="btn-like primary">${esc(t('baSave'))}</button>
        </div>
        <div class="si-row">
          <select id="baJob" class="si-select"></select>
          <input type="date" id="baFrom" class="si-select">
          <input type="date" id="baTo" class="si-select">
          <button id="baGo" class="btn-like primary">${esc(t('baAnalyze'))}</button>
        </div>
        <div id="baStatus" class="si-status"></div>
        <div id="baOut"></div>
      </div>
    `;

    const $ = (s) => root.querySelector(s);
    let groups = [];
    const status = (m, cls) => { const e = $('#baStatus'); e.textContent = m || ''; e.className = 'si-status' + (cls ? ' ' + cls : ''); };

    async function loadGroups() {
      const r = await fetch('/api/brand-analytics/groups').then((x) => x.json()).catch(() => ({ groups: [] }));
      groups = r.groups || [];
      renderGroups();
    }
    function renderGroups() {
      $('#baGroups').innerHTML = groups.length
        ? groups
            .map(
              (g, i) => `<div class="ba-g"><b>${esc(g.name)}</b> <span class="m-ver">${g.handles.map((h) => '@' + esc(h)).join(' ')}</span>
                <button data-i="${i}" class="ba-del" title="${esc(t('baDel'))}">×</button></div>`
            )
            .join('')
        : `<div class="si-status">${esc(t('baNoGroups'))}</div>`;
      root.querySelectorAll('.ba-del').forEach((b) =>
        b.addEventListener('click', () => {
          groups.splice(Number(b.dataset.i), 1);
          renderGroups();
          save();
        })
      );
    }
    async function save() {
      const r = await fetch('/api/brand-analytics/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups }),
      }).then((x) => x.json());
      if (r.groups) groups = r.groups;
      status(t('baSaved'), 'ok');
    }

    $('#baAdd').addEventListener('click', () => {
      const name = $('#baName').value.trim();
      const handles = $('#baHandles').value.split(/[\s,]+/).map((x) => x.replace(/^@/, '').trim()).filter(Boolean);
      if (!name || !handles.length) return status(t('baNeedBoth'), 'err');
      const ex = groups.find((g) => g.name === name);
      if (ex) ex.handles = [...new Set(ex.handles.concat(handles))];
      else groups.push({ name, handles });
      renderGroups();
      $('#baName').value = '';
      $('#baHandles').value = '';
      save();
    });
    $('#baSave').addEventListener('click', save);

    async function analyze() {
      const jobId = $('#baJob').value;
      if (!jobId) return status(t('siNeedJob'), 'err');
      status(t('siAnalyzing'));
      const r = await fetch('/api/brand-analytics/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, from: $('#baFrom').value || undefined, to: $('#baTo').value || undefined }),
      }).then((x) => x.json());
      if (r.error) return status(r.error, 'err');
      render(r);
      status(t('siDone'), 'ok');
    }
    $('#baGo').addEventListener('click', analyze);

    function render(r) {
      if (r.ungrouped && r.ungrouped.length) {
        status(t('baUngrouped', { n: r.ungrouped.length }) + ' ' + r.ungrouped.map((h) => '@' + h).join(' '), 'err');
      }
      const metricRows = [
        ['baFans', (b) => fmt(b.fans)],
        ['colViews', (b) => fmt(b.tv)],
        ['baAvgViews', (b) => fmt(b.avg)],
        ['baMaxViews', (b) => fmt(b.max)],
        ['colLikes', (b) => fmt(b.likes)],
        ['colComments', (b) => fmt(b.comments)],
        ['colShares', (b) => fmt(b.shares)],
        ['colSaves', (b) => fmt(b.saves)],
        ['colReposts', (b) => fmt(b.reposts)],
        ['colEngage', (b) => pct(b.inter)],
        ['baAvgDuration', (b) => fmt(b.avgDuration) + 's'],
        ['baCartedCount', (b) => fmt(b.ecN)],
        ['baShare', (b) => pct(b.viewShare)],
      ];
      const heads = r.brands.map((b) => `<th class="num">${esc(b.name)}</th>`).join('');
      const body = metricRows
        .map(([label, get]) => `<tr><td>${esc(t(label))}</td>${r.brands.map((b) => `<td class="num">${get(b)}</td>`).join('')}</tr>`)
        .join('');

      const accTables = r.brands
        .map(
          (b) => `
        <h3 class="ba-h">${esc(b.name)} · ${esc(t('baAccountCompare'))}</h3>
        <div class="tbl-wrap"><table class="ec-table">
          <thead><tr>
            <th>${esc(t('colAccount'))}</th><th class="num">${esc(t('baFans'))}</th>
            <th class="num">${esc(t('colViews'))}</th><th class="num">${esc(t('baViewShare'))}</th>
            <th class="num">${esc(t('baAvgViews'))}</th><th class="num">${esc(t('colEngage'))}</th>
            <th class="num">${esc(t('baAvgDuration'))}</th><th class="num">${esc(t('baItems'))}</th>
          </tr></thead>
          <tbody>${b.perAccount
            .map(
              (a) => `<tr><td>@${esc(a.handle)}</td><td class="num">${fmt(a.followers)}</td>
                <td class="num">${fmt(a.tv)}</td><td class="num">${pct(a.viewShare)}</td>
                <td class="num">${fmt(a.avg)}</td><td class="num">${pct(a.inter)}</td>
                <td class="num">${fmt(a.avgDuration)}s</td><td class="num">${fmt(a.n)}</td></tr>`
            )
            .join('')}</tbody>
        </table></div>
        <h3 class="ba-h">${esc(b.name)} · ${esc(t('baTrend'))}</h3>
        <div class="tbl-wrap"><table class="ec-table">
          <thead><tr><th>${esc(t('colMonth'))}</th><th class="num">${esc(t('baItems'))}</th>
            <th class="num">${esc(t('colViews'))}</th><th class="num">${esc(t('colLikes'))}</th>
            <th class="num">${esc(t('colComments'))}</th><th class="num">${esc(t('colShares'))}</th>
            <th class="num">${esc(t('colSaves'))}</th></tr></thead>
          <tbody>${b.trend
            .map(
              (m) => `<tr><td>${esc(m.month)}</td><td class="num">${fmt(m.count)}</td><td class="num">${fmt(m.views)}</td>
                <td class="num">${fmt(m.likes)}</td><td class="num">${fmt(m.comments)}</td>
                <td class="num">${fmt(m.shares)}</td><td class="num">${fmt(m.saves)}</td></tr>`
            )
            .join('')}</tbody>
        </table></div>
        <h3 class="ba-h">${esc(b.name)} · ${esc(t('baTop'))}</h3>
        <div class="tbl-wrap"><table class="ec-table">
          <thead><tr><th>#</th><th>${esc(t('colAccount'))}</th><th>${esc(t('colDate'))}</th>
            <th>${esc(t('colCaption'))}</th><th class="num">${esc(t('colViews'))}</th>
            <th class="num">${esc(t('colLikes'))}</th><th class="num">${esc(t('colDuration'))}</th>
            <th class="ctr">${esc(t('colShopping'))}</th><th></th></tr></thead>
          <tbody>${b.top
            .map(
              (v, i) => `<tr><td class="num">${i + 1}</td><td>@${esc(v.account)}</td><td class="num">${esc(v.date)}</td>
                <td class="ba-desc">${esc(v.desc || '-')}</td><td class="num">${fmt(v.views)}</td>
                <td class="num">${fmt(v.likes)}</td><td class="num">${esc(v.duration)}s</td>
                <td class="ctr">${v.isEC ? esc(t('yesShort')) : '—'}</td>
                <td><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(t('colOpen'))}</a></td></tr>`
            )
            .join('')}</tbody>
        </table></div>`
        )
        .join('');

      $('#baOut').innerHTML = `
        <div class="tbl-wrap"><table class="ec-table">
          <thead><tr><th>${esc(t('siMetric'))}</th>${heads}</tr></thead>
          <tbody>${body}</tbody>
        </table></div>
        ${accTables}`;
    }

    (async () => {
      await loadGroups();
      const jobs = await fetch('/api/jobs').then((x) => x.json()).catch(() => []);
      $('#baJob').innerHTML = jobs
        .map((j) => `<option value="${esc(j.id)}">${esc((j.id || '').slice(0, 10))} · ${(j.handles || []).join(',')} · ${j.count || 0}条</option>`)
        .join('');
    })();
  }

  window.TTModule.register({ id: 'brand-analytics', title: '品牌媒体分析', icon: '◎', mount });
})();

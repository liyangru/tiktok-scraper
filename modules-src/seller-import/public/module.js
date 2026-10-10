/* 卖家中心导入与挂车分析 —— 前端面板 */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US'));

  function mount(root, ctx) {
    const t = ctx.t;
    root.innerHTML = `
      <div class="si-rule">${esc(t('siRule'))}</div>
      <div class="si-login">
        <div class="si-row">
          <input id="siAcc" class="si-select" placeholder="${esc(t('siAcc'))}" autocomplete="off" style="min-width:180px">
          <input id="siPwd" class="si-select" type="password" placeholder="${esc(t('siPwd'))}" autocomplete="new-password" style="min-width:160px">
          <button id="siLogin" class="btn-like primary">${esc(t('siLogin'))}</button>
        </div>
        <div class="si-hint">${esc(t('siLoginHint'))}</div>
      </div>
      <div class="si-row">
        <button id="siOpenSeller" class="btn-like">${esc(t('siOpenSeller'))}</button>
        <span class="si-hint">${esc(t('siOpenSellerHint'))}</span>
      </div>
      <div class="si-row">
        <label class="si-upload btn-like primary">${esc(t('siUpload'))}
          <input type="file" id="siFile" accept=".xlsx" style="display:none">
        </label>
        <select id="siJob" class="si-select"></select>
        <select id="siFile" class="si-select"></select>
        <button id="siAnalyze" class="btn-like primary" disabled>${esc(t('siAnalyze'))}</button>
      </div>
      <div id="siStatus" class="si-status"></div>
      <div id="siResult"></div>
    `;

    const $ = (s) => root.querySelector(s);
    const status = (m, cls) => { const e = $('#siStatus'); e.textContent = m || ''; e.className = 'si-status' + (cls ? ' ' + cls : ''); };

    async function refresh() {
      // 任务下拉
      const jobs = await fetch('/api/jobs').then((x) => x.json()).catch(() => []);
      $('#siJob').innerHTML = jobs
        .map((j) => `<option value="${esc(j.id)}">${esc((j.id || '').slice(0, 10))} · ${(j.handles || []).join(',')} · ${j.count || 0}条</option>`)
        .join('');
      // 文件下拉
      const f = await fetch('/api/seller-import/files').then((x) => x.json()).catch(() => ({ files: [] }));
      $('#siFile').innerHTML = f.files
        .map((x) => `<option value="${esc(x.file)}">${esc((x.dateRange || x.file).slice(0, 40))} (${x.rows}条)</option>`)
        .join('');
      $('#siAnalyze').disabled = !(f.files.length && jobs.length);
    }

    $('#siFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      status(t('siParsing'));
      const buf = await file.arrayBuffer();
      const r = await fetch('/api/seller-import/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
        body: buf,
      }).then((x) => x.json());
      if (r.error) return status(r.error, 'err');
      status(t('siParsed', { n: r.count, range: r.dateRange || '-' }), 'ok');
      refresh();
    });

    $('#siLogin').addEventListener('click', async () => {
      const account = $('#siAcc').value.trim();
      const password = $('#siPwd').value;
      if (!account || !password) return status(t('siNeedAccPwd'), 'err');
      status(t('siLoggingIn'));
      $('#siLogin').disabled = true;
      try {
        const r = await fetch('/api/seller-import/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account, password }),
        }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        if (r.needManual) {
          // 出验证码：已经自动切回有头窗口，用户只处理验证
          status(t('siNeedManual', { reason: r.reason || '' }) + (r.note ? ' · ' + r.note : ''), 'err');
        } else {
          status(t('siLoginOk'), 'ok');
          $('#siPwd').value = '';
        }
      } catch (e) {
        status(e.message, 'err');
      } finally {
        $('#siLogin').disabled = false;
      }
    });

    $('#siOpenSeller').addEventListener('click', async () => {
      status(t('siOpening'));
      try {
        const r = await fetch('/api/seller-import/open-browser', { method: 'POST' }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        status(t('siOpened') + (r.note ? ' · ' + r.note : ''), 'ok');
      } catch (e) {
        status(e.message, 'err');
      }
    });

    $('#siAnalyze').addEventListener('click', async () => {
      const jobId = $('#siJob').value;
      const file = $('#siFile').value;
      if (!jobId) return status(t('siNeedJob'), 'err');
      status(t('siAnalyzing'));
      const r = await fetch('/api/seller-import/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, file: file || undefined }),
      }).then((x) => x.json());
      if (r.error) return status(r.error, 'err');
      render(r);
      status(t('siDone'), 'ok');
    });

    function render(r) {
      const c = r.counts;
      const m = r.compare;
      const labels = t('siMetrics');
      const row = (label, a, b, pct) => {
        const has = Number(b) !== 0;
        const d = has ? ((a - b) / b) * 100 : null;
        const cls = d === null ? '' : d >= 0 ? 'pos' : 'neg';
        return `<tr><td>${esc(label)}</td><td class="num">${fmt(a)}</td><td class="num">${fmt(b)}</td>
          <td class="num ${cls}">${d === null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(1) + '%'}</td>
          <td class="num">${pct ? fmt(pct) : ''}</td></tr>`;
      };
      const mk = (k, i) => row(labels[i] || k, m.ec[k], m.non[k], m.ec[k === 'n' ? 'gmv' : ''] || (k === 'gmv' ? m.ec.gmv : ''));
      const pairs = [
        ['n', 0], ['tv', 1], ['avg', 2], ['med', 3], ['max', 4],
        ['avgLikes', 5], ['avgComments', 6], ['avgShares', 7], ['avgSaves', 8], ['avgReposts', 9],
        ['avgDuration', 10], ['inter', 11], ['gmv', 12], ['orders', 13], ['productClicks', 14], ['gpm', 15],
      ];
      $('#siResult').innerHTML = `
        <div class="si-cards">
          <div class="si-card"><b>${fmt(c.tiktok)}</b><span>${esc(t('siTikTok'))}</span></div>
          <div class="si-card"><b>${fmt(c.carted)}</b><span>${esc(t('siCarted'))}</span></div>
          <div class="si-card"><b>${fmt(c.nonCarted)}</b><span>${esc(t('siNonCarted'))}</span></div>
          <div class="si-card dim"><b>${fmt(c.sellerOnly)}</b><span>${esc(t('siSellerOnly'))}</span></div>
        </div>
        <div class="si-note">${esc(t('siSellerOnlyNote'))}（${esc(r.file)} · ${esc(r.dateRange || '-')}）
          · ${esc(t('siFlagCheck', { agree: r.flagCheck.agree, disagree: r.flagCheck.disagree }))}</div>
        <div class="tbl-wrap"><table class="ec-table">
          <thead><tr>
            <th>${esc(t('siMetric'))}</th><th class="num">${esc(t('siCarted'))}</th>
            <th class="num">${esc(t('siNonCarted'))}</th><th class="num">${esc(t('siDiff'))}</th>
            <th class="num">${esc(t('siGmv'))}</th>
          </tr></thead>
          <tbody>${pairs.map(([k, i]) => mk(k, i)).join('')}</tbody>
        </table></div>`;
    }

    refresh();
  }

  window.TTModule.register({ id: 'seller-import', title: '卖家中心导入', icon: '⇪', mount });
})();

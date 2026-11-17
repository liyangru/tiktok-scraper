/* AI 分析与复刻脚本 —— 前端面板 */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');

  function mount(root, ctx) {
    const t = ctx.t;
    root.innerHTML = `
      <div class="si-hint">${esc(t('aiHint'))}</div>
      <div class="si-row">
        <select id="aiVid" class="si-select" style="flex:1;min-width:300px"></select>
        <button id="aiVideo" class="btn-like primary">${esc(t('aiVideoBtn'))}</button>
        <button id="aiRemake" class="btn-like">${esc(t('aiRemakeBtn'))}</button>
      </div>
      <div class="si-row">
        <select id="aiJob" class="si-select" style="flex:1;min-width:260px"></select>
        <button id="aiBrand" class="btn-like">${esc(t('aiBrandBtn'))}</button>
      </div>
      <div id="aiStatus" class="si-status"></div>
      <div id="aiOut" class="ai-out"></div>`;

    const $ = (s) => root.querySelector(s);
    const status = (m, cls) => {
      const e = $('#aiStatus');
      e.textContent = m || '';
      e.className = 'si-status' + (cls ? ' ' + cls : '');
    };
    const show = (md, file) => {
      $('#aiOut').innerHTML =
        '<div class="ai-md">' +
        esc(md).replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/\n/g, '<br>') +
        (file ? '<div class="si-hint">' + esc(t('aiSaved')) + ': ' + esc(file) + '</div>' : '') +
        '</div>';
    };

    async function loadVideos() {
      const d = await fetch('/api/ai-analyst/videos').then((x) => x.json()).catch(() => ({ videos: [], db: {} }));
      $('#aiVid').innerHTML = (d.videos || [])
        .map(
          (v) =>
            `<option value="${esc(v.vid)}">@${esc(v.account)} · ${esc((v.desc || v.vid).slice(0, 40))} · ${fmt(v.views)}${v.hasPlay ? '' : ' ' + esc(t('aiNoDirect'))}</option>`
        )
        .join('');
      if (d.db) status(t('aiDbStats', { v: d.db.videos, a: d.db.accounts }), 'ok');
      const jobs = await fetch('/api/jobs').then((x) => x.json()).catch(() => []);
      $('#aiJob').innerHTML = jobs
        .map((j) => `<option value="${esc(j.id)}">${esc((j.id || '').slice(0, 10))} · ${esc((j.handles || []).join(','))}</option>`)
        .join('');
    }

    async function post(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      return r;
    }

    $('#aiVideo').addEventListener('click', async () => {
      const vid = $('#aiVid').value;
      if (!vid) return;
      status(t('aiWorking'));
      try {
        const r = await post('/api/ai-analyst/video', { vid });
        show(r.analysis, r.file);
        status(t('siDone'), 'ok');
      } catch (e) {
        status(e.message, 'err');
      }
    });

    $('#aiBrand').addEventListener('click', async () => {
      const jobId = $('#aiJob').value;
      if (!jobId) return;
      status(t('aiWorking'));
      try {
        const r = await post('/api/ai-analyst/brand', { jobId });
        show(r.analysis, r.file);
        status(t('siDone'), 'ok');
      } catch (e) {
        status(e.message, 'err');
      }
    });

    $('#aiRemake').addEventListener('click', async () => {
      const vid = $('#aiVid').value;
      if (!vid) return;
      status(t('aiRemakeWorking'));
      try {
        const r = await post('/api/ai-analyst/remake', { vid });
        show(r.script, r.file);
        status(t('aiRemakeDone', { n: r.frames }), 'ok');
      } catch (e) {
        status(e.message, 'err');
      }
    });

    loadVideos();
  }

  window.TTModule.register({ id: 'ai-analyst', title: 'AI 分析', icon: '✦', mount });
})();

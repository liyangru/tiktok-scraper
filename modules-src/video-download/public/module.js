/* 视频下载模块 —— 前端
 * 通过 window.TTModule.register 注册到主程序，主程序负责把它挂到 #module-panels。
 * 模块自己不碰主程序的 DOM 结构，只用 ctx 提供的工具函数。
 */
(function () {
  const API = '';

  function el(html) {
    const d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstElementChild;
  }
  const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function mount(root, ctx) {
  const t = ctx.t;
  const esc2 = esc;
  root.innerHTML = `
    <div class="si-row">
      <input id="dlInput" class="si-select" style="flex:1;min-width:280px" placeholder="${esc2(t('dlUnifiedHint'))}">
      <select id="dlQuality" class="si-select" style="max-width:150px">
        <option value="best" selected>${esc2(t('dlBest'))}</option>
        <option value="hd">1080p</option>
        <option value="sd">540p</option>
      </select>
      <button id="dlResolve" class="btn-like primary">${esc2(t('dlResolve'))}</button>
    </div>
    <div class="si-hint">${esc2(t('dlUnifiedTip'))}</div>
    <div id="dlStatus" class="si-status"></div>
    <div id="dlList" class="dl-list"></div>`;

  const $ = (x) => root.querySelector(x);
  const status = (m, cls) => { const e = $('#dlStatus'); e.textContent = m || ''; e.className = 'si-status' + (cls ? ' ' + cls : ''); };
  let items = [];

  /** 自动识别：URL → 按链接解析；@handle 或纯用户名 → 按主页解析 */
  function detect(input) {
    const v = input.trim();
    if (/^https?:\/\//i.test(v)) return 'urls';
    return 'handle';
  }

  function renderList() {
    if (!items.length) { $('#dlList').innerHTML = ''; return; }
    $('#dlList').innerHTML = items
      .map(
        (it, i) => `<div class="dl-item" data-i="${i}">
          <div class="dl-thumb">${it.cover ? `<img src="${esc2(it.cover)}" alt="">` : '<span class="dim">▶</span>'}</div>
          <div class="dl-info">
            <div class="dl-desc">${esc2((it.desc || t('dlNoCaption')).slice(0, 60))}</div>
            <div class="si-hint">@${esc2(it.account || '')} · ${esc2(it.duration ? it.duration + 's' : '')} ${it.quality ? '· ' + esc2(it.quality) : ''}</div>
          </div>
          <button type="button" class="dl-go btn-like primary" data-i="${i}">${esc2(t('dlDownload'))}</button>
        </div>`
      )
      .join('');
    root.querySelectorAll('.dl-go').forEach((b) =>
      b.addEventListener('click', () => download(items[Number(b.dataset.i)], b))
    );
  }

  async function download(it, btn) {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = t('dlResolving');
    try {
      const r = await fetch('/api/video-download/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [it], quality: $('#dlQuality').value }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      const poll = setInterval(async () => {
        const job = await fetch(`/api/video-download/jobs/${r.jobId}`).then((x) => x.json()).catch(() => null);
        if (!job) return;
        if (job.status === 'done' || job.status === 'error') {
          clearInterval(poll);
          const ok = (job.files || []).length;
          btn.disabled = false;
          btn.textContent = old;
          status(ok ? t('dlFinished', { ok, bad: 0 }) : t('dlFinished', { ok: 0, bad: (job.errors || []).length }) + ' · ' + (job.errors[0] || ''), ok ? 'ok' : 'err');
        }
      }, 1200);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = old;
      status(e.message, 'err');
    }
  }

  $('#dlResolve').addEventListener('click', async () => {
    const input = $('#dlInput').value.trim();
    if (!input) return status(t('dlNeedInput'), 'err');
    const mode = detect(input);
    status(t('dlResolving'));
    $('#dlResolve').disabled = true;
    try {
      const r = await fetch('/api/video-download/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, input, quality: $('#dlQuality').value }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      items = r.items || [];
      renderList();
      status(items.length ? t('dlResolved', { n: items.length }) : (r.errors || []).join('; '), items.length ? 'ok' : 'err');
    } catch (e) {
      status(e.message, 'err');
    } finally {
      $('#dlResolve').disabled = false;
    }
  });
}

window.TTModule.register({
    id: 'video-download',
    title: '视频下载',
    icon: '↓',
    mount,
  });
})();

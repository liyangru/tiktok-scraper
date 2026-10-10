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
    root.innerHTML = `
      <div class="dl-modes" id="dlModes">
        <button data-mode="urls" class="on">${esc(t('dlModeUrls'))}</button>
        <button data-mode="handle">${esc(t('dlModeHandle'))}</button>
      </div>
      <textarea id="dlInput" class="dl-input" rows="5"
        placeholder="${esc(t('dlPlaceholder'))}"></textarea>
      <div class="dl-row">
        <select id="dlQuality" class="dl-select">
          <option value="best">${esc(t('dlBest'))}</option>
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="540p">540p</option>
        </select>
        <button id="dlResolve" class="primary">${esc(t('dlResolve'))}</button>
        <button id="dlFetch" disabled>${esc(t('dlDownload'))}</button>
        <button id="dlOpen" disabled>${esc(t('dlOpenDir'))}</button>
      </div>
      <div id="dlStatus" class="dl-status"></div>
      <div id="dlList" class="dl-list"></div>
    `;

    let mode = 'urls';
    let items = [];
    let outDir = '';

    const $ = (s) => root.querySelector(s);
    const status = (msg, cls) => {
      $('#dlStatus').textContent = msg || '';
      $('#dlStatus').className = 'dl-status' + (cls ? ' ' + cls : '');
    };

    root.querySelectorAll('#dlModes button').forEach((b) =>
      b.addEventListener('click', () => {
        mode = b.dataset.mode;
        root.querySelectorAll('#dlModes button').forEach((x) => x.classList.toggle('on', x === b));
        $('#dlInput').placeholder = mode === 'handle' ? t('dlPlaceholderHandle') : t('dlPlaceholder');
      })
    );

    async function resolve() {
      const input = $('#dlInput').value.trim();
      if (!input) return status(t('dlNeedInput'), 'err');
      status(t('dlResolving'));
      $('#dlResolve').disabled = true;
      try {
        const r = await fetch(`${API}/api/video-download/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, input }),
        }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        items = r.items || [];
        render();
        status(
          t('dlResolved', { n: items.length }) + (r.errors && r.errors.length ? ' · ' + r.errors.join('; ') : ''),
          items.length ? 'ok' : 'err'
        );
      } catch (e) {
        status(e.message, 'err');
      } finally {
        $('#dlResolve').disabled = false;
      }
    }

    function render() {
      if (!items.length) {
        $('#dlList').innerHTML = '';
        $('#dlFetch').disabled = true;
        return;
      }
      $('#dlList').innerHTML = items
        .map((it, i) => {
          const q = it.streams && it.streams.length ? it.streams[0].quality || '?' : '—';
          const badge = it.watermarked ? `<span class="dl-warn">${esc(t('dlWatermark'))}</span>` : `<span class="dl-ok">${esc(t('dlClean'))}</span>`;
          return `<label class="dl-item">
            <input type="checkbox" data-i="${i}" checked>
            <span class="dl-meta">
              <b>@${esc(it.author || '?')}</b>
              <span class="dl-desc">${esc(it.desc || t('dlNoCaption'))}</span>
              <span class="dl-tags">${esc(it.duration ? it.duration + 's' : '')} · ${esc(q)} · ${badge}</span>
            </span>
          </label>`;
        })
        .join('');
      $('#dlFetch').disabled = false;
    }

    async function download() {
      const picked = [...root.querySelectorAll('#dlList input:checked')].map((c) => items[Number(c.dataset.i)]);
      if (!picked.length) return status(t('dlNeedPick'), 'err');
      status(t('dlDownloading', { n: picked.length }));
      $('#dlFetch').disabled = true;
      try {
        const r = await fetch(`${API}/api/video-download/fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: picked, quality: $('#dlQuality').value }),
        }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        outDir = r.outDir;
        $('#dlOpen').disabled = false;
        // 轮询进度
        for (let i = 0; i < 600; i++) {
          await new Promise((s) => setTimeout(s, 1000));
          const j = await fetch(`${API}/api/video-download/jobs/${r.jobId}`).then((x) => x.json());
          status(t('dlProgress', { done: j.done, total: j.total }));
          if (j.status === 'done' || j.status === 'error') {
            const ok = j.files.length;
            const bad = j.errors.length;
            status(t('dlFinished', { ok, bad }) + (bad ? ' · ' + j.errors.map((e) => e.error).join('; ') : ''), bad && !ok ? 'err' : 'ok');
            break;
          }
        }
      } catch (e) {
        status(e.message, 'err');
      } finally {
        $('#dlFetch').disabled = false;
      }
    }

    $('#dlResolve').addEventListener('click', resolve);
    $('#dlFetch').addEventListener('click', download);
    $('#dlOpen').addEventListener('click', () =>
      fetch(`${API}/api/video-download/open-dir`, { method: 'POST' })
    );
  }

  window.TTModule.register({
    id: 'video-download',
    title: '视频下载',
    icon: '↓',
    mount,
  });
})();

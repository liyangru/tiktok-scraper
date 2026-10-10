/* TikTok 账号登录 —— 实时状态 + 扫码后补验证 */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function mount(root, ctx) {
    const t = ctx.t;
    root.innerHTML = `
      <div class="tl-tabs">
        <button class="on" data-m="qr">${esc(t('tlQr'))}</button>
        <button data-m="password">${esc(t('tlPwd'))}</button>
        <select id="tlAccSel" class="si-select" style="margin-left:auto;max-width:200px" title="${esc(t('tlAccounts'))}"></select>
      </div>

      <div id="tlStage" class="tl-stage">
        <div class="tl-spinner" id="tlSpin"></div>
        <div class="tl-msg" id="tlMsg">${esc(t('tlIdle'))}</div>
      </div>

      <div id="tlQrWrap" class="tl-qr-wrap" style="display:none">
        <img id="tlQrImg" class="tl-img" alt="QR">
        <div class="si-hint">${esc(t('tlQrTip'))}</div>
      </div>

      <div id="tlForm" class="si-row" style="display:none">
        <input id="tlF1" class="si-select" style="flex:1;min-width:160px">
        <input id="tlF2" class="si-select" type="password" style="flex:1;min-width:160px;display:none">
        <button id="tlSubmit" class="btn-like primary">${esc(t('tlSubmit'))}</button>
      </div>

      <div class="si-row" style="margin-top:12px">
        <button id="tlGo" class="btn-like primary">${esc(t('tlStart'))}</button>
        <button id="tlClose" class="btn-like">${esc(t('tlClose'))}</button>
      </div>

      <div class="si-hint">${esc(t('tlValue'))}</div>`;

    const $ = (s) => root.querySelector(s);
    let mode = 'qr';
    let timer = null;
    let lastPhase = '';

    const spin = (on) => { $('#tlSpin').style.display = on ? 'block' : 'none'; };
    const msg = (m, cls) => { const e = $('#tlMsg'); e.textContent = m || ''; e.className = 'tl-msg' + (cls ? ' ' + cls : ''); };

    root.querySelectorAll('.tl-tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        mode = b.dataset.m;
        root.querySelectorAll('.tl-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      })
    );

    function render(s) {
      const showQr = !!s.qr;
      if (showQr) {
        $('#tlQrWrap').style.display = 'block';
        $('#tlQrImg').src = 'data:image/png;base64,' + s.qr;
      } else {
        $('#tlQrWrap').style.display = 'none';
      }

      const needInput = s.phase === 'need-input';
      $('#tlForm').style.display = needInput ? 'flex' : 'none';

      const busy = ['launching', 'loading'].includes(s.phase);
      spin(busy || s.phase === 'waiting-scan' || s.phase === 'scanned');
      $('#tlGo').disabled = busy;

      let text = s.message || '';
      let cls = '';
      if (s.phase === 'logged-in') { text = t('tlOk'); cls = 'ok'; spin(false); }
      else if (s.phase === 'error') { cls = 'err'; spin(false); }
      else if (s.phase === 'waiting-scan' || s.phase === 'scanned') { cls = 'wait'; }
      else if (s.phase === 'idle') { text = t('tlIdle'); }
      msg(text, cls);

      if (needInput) {
        const kind = s.inputKind;
        if (kind === 'account') {
          $('#tlF1').style.display = 'block';
          $('#tlF1').placeholder = t('siAcc');
          $('#tlF2').style.display = 'block';
          $('#tlF2').placeholder = t('siPwd');
        } else if (kind === 'password') {
          $('#tlF1').style.display = 'none';
          $('#tlF2').style.display = 'block';
          $('#tlF2').placeholder = t('siPwd');
        } else {
          $('#tlF1').style.display = 'block';
          $('#tlF1').placeholder = t('tlCodePlaceholder');
          $('#tlF2').style.display = 'none';
        }
      }
      lastPhase = s.phase;
    }

    async function poll() {
      try {
        const s = await fetch('/api/tiktok-login/state', { cache: 'no-store' }).then((x) => x.json());
        render(s);
        if ((s.phase === 'logged-in' || s.phase === 'error' || s.phase === 'idle') && timer) {
          clearInterval(timer);
          timer = null;
        }
      } catch (_) {}
    }

    function startPolling() {
      if (timer) clearInterval(timer);
      timer = setInterval(poll, 1500);
      poll();
    }

    $('#tlGo').addEventListener('click', async () => {
      lastPhase = '';
      msg(t('tlStarting'), 'wait');
      spin(true);
      try {
        const r = await fetch('/api/tiktok-login/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, account: $('#tlAccSel').value || '' }),
        }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        startPolling();
      } catch (e) {
        msg(e.message, 'err');
        spin(false);
      }
    });

    $('#tlSubmit').addEventListener('click', async () => {
      const b = {};
      const v1 = $('#tlF1').value.trim();
      const v2 = $('#tlF2').value;
      if ($('#tlF2').style.display !== 'none' && v2) {
        b.account = v1;
        b.password = v2;
      } else if (v1) {
        b.code = v1;
      }
      try {
        const r = await fetch('/api/tiktok-login/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(b),
        }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        $('#tlF1').value = '';
        $('#tlF2').value = '';
        msg(t('tlSubmitted'), 'wait');
        startPolling();
      } catch (e) {
        msg(e.message, 'err');
      }
    });

    $('#tlClose').addEventListener('click', async () => {
      await fetch('/api/tiktok-login/close', { method: 'POST' }).catch(() => {});
      if (timer) { clearInterval(timer); timer = null; }
      lastPhase = '';
      msg(t('tlIdle'));
      spin(false);
      $('#tlQrWrap').style.display = 'none';
      $('#tlForm').style.display = 'none';
    });

    async function loadAccounts() {
      const d = await fetch('/api/tiktok-login/accounts').then((x) => x.json()).catch(() => ({ accounts: [] }));
      const list = d.accounts && d.accounts.length ? d.accounts : ['default'];
      $('#tlAccSel').innerHTML = list.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    }

    loadAccounts();
    poll(); // 进面板先看一次当前状态（可能是上次留下的登录态）
  }

  window.TTModule.register({ id: 'tiktok-login', title: 'TikTok 登录', icon: '◎', mount });
})();

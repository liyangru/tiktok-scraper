/* TikTok 账号登录 —— 扫码优先，可切账密 */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function mount(root, ctx) {
    const t = ctx.t;
    root.innerHTML = `
      <div class="tl-tabs"><button class="on" data-m="qr">${esc(t('tlQr'))}</button><button data-m="pwd">${esc(t('tlPwd'))}</button></div>
      <div id="tlQrBox" class="tl-qr"><div class="si-status">${esc(t('tlClickFirst'))}</div></div>
      <div id="tlPwdBox" style="display:none">
        <div class="si-row">
          <input id="tlAcc" class="si-select" placeholder="${esc(t('siAcc'))}" style="min-width:180px">
          <input id="tlPwd2" class="si-select" type="password" placeholder="${esc(t('siPwd'))}" style="min-width:150px">
          <button id="tlGo" class="btn-like primary">${esc(t('siLogin'))}</button>
        </div>
      </div>
      <div class="si-hint">${esc(t('tlValue'))}</div>
      <div id="tlStatus" class="si-status"></div>`;
    const $ = (s) => root.querySelector(s);
    const status = (m, cls) => { const e = $('#tlStatus'); e.textContent = m || ''; e.className = 'si-status' + (cls ? ' ' + cls : ''); };
    root.querySelectorAll('.tl-tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        root.querySelectorAll('.tl-tabs button').forEach((x) => x.classList.toggle('on', x === b));
        $('#tlQrBox').style.display = b.dataset.m === 'qr' ? 'block' : 'none';
        $('#tlPwdBox').style.display = b.dataset.m === 'pwd' ? 'block' : 'none';
      })
    );
    $('#tlQrBox').addEventListener('click', async () => {
      status(t('siLoggingIn'));
      try {
        const r = await fetch('/api/tiktok-login/qr', { method: 'POST' }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        $('#tlQrBox').innerHTML = '<img class="tl-img" src="data:image/png;base64,' + r.qr + '"><div class="si-hint">' + esc(r.note) + '</div>';
        const poll = setInterval(async () => {
          const s = await fetch('/api/tiktok-login/status').then((x) => x.json()).catch(() => null);
          if (s && s.loggedIn) { clearInterval(poll); status(t('tlOk'), 'ok'); }
        }, 3000);
      } catch (e) { status(e.message, 'err'); }
    });
    $('#tlGo').addEventListener('click', async () => {
      status(t('siLoggingIn'));
      try {
        const r = await fetch('/api/tiktok-login/password', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account: $('#tlAcc').value.trim(), password: $('#tlPwd2').value }),
        }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        status(r.loggedIn ? t('tlOk') : (r.reason || t('siNeedManual')), r.loggedIn ? 'ok' : 'err');
      } catch (e) { status(e.message, 'err'); }
    });
    fetch('/api/tiktok-login/status').then((x) => x.json()).then((s) => { if (s.loggedIn) status(t('tlAlready'), 'ok'); }).catch(() => {});
  }
  window.TTModule.register({ id: 'tiktok-login', title: 'TikTok 登录', icon: '◎', mount });
})();

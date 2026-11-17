/* 创作中心登录 —— 版式由核心的统一登录面板提供（与卖家中心登录完全一致） */
(function () {
  const ESC = { '&': '&#38;', '<': '&#60;', '>': '&#62;', '"': '&#34;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  /**
   * 兼容旧版核心的降级面板。
   * ⚠️ 模块是单独分发的，完全可能出现「旧的 1.1.8 应用 + 新的 1.3.0 模块」这种组合；
   *    那种核心里还没有 window.TTLoginUI，这里必须还能完成登录，
   *    而不是把登录入口变成一句「版本过旧」的报错。
   */
  function legacyPanel(root, ctx, spec) {
    const t = ctx.t;
    const get = (u) => fetch(u, { cache: 'no-store' }).then((x) => x.json());
    const post = (u, b) =>
      fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then((x) => x.json());

    root.innerHTML = `
      <div class="si-row"><select id="fbAcc" class="si-select" style="flex:1;min-width:180px"></select>
        <button id="fbAdd" class="btn-like">${esc(t('siAddAccount'))}</button></div>
      <div class="si-row">
        <button id="fbGo" class="btn-like primary">${esc(t(spec.goKey))}</button>
        <button id="fbCheck" class="btn-like">${esc(t('siCheckStatus'))}</button>
      </div>
      <div id="fbMsg" class="si-status"></div>
      <div class="si-hint">${esc(t(spec.hintKey))}</div>
      <div class="si-hint">${esc(t('tlQrTip'))}</div>`;
    const $ = (s) => root.querySelector(s);
    const msg = (m, cls) => {
      const e = $('#fbMsg');
      if (e) { e.textContent = m || ''; e.className = 'si-status' + (cls ? ' ' + cls : ''); }
    };
    let active = '';

    async function load() {
      const d = await get(spec.api.list).catch(() => ({ accounts: [] }));
      const accounts = d.accounts || [];
      active = d.active || (accounts[0] && accounts[0].id) || '';
      $('#fbAcc').innerHTML = accounts.length
        ? accounts
            .map((a) => `<option value="${esc(a.id)}"${a.id === active ? ' selected' : ''}>${esc(a.label || a.account || a.id)}${a.hasSession ? ' ✓' : ''}</option>`)
            .join('')
        : `<option value="">${esc(t('siNoAccountYet'))}</option>`;
    }

    $('#fbAcc').addEventListener('change', () => {
      active = $('#fbAcc').value;
      post(spec.api.active(active), {}).catch(() => {});
    });
    $('#fbGo').addEventListener('click', async () => {
      if (!active) return msg(t('tlAccounts'), 'err');
      msg(t('tlStarting'), 'wait');
      try {
        const r = await spec.start({ mode: 'qr', id: active, account: '' });
        if (r && r.error) throw new Error(r.error);
        msg((r && r.note) || t('tlStarting'), r && r.visible ? 'wait' : 'ok');
        setTimeout(load, 1500);
      } catch (e) {
        msg(e.message, 'err');
      }
    });
    $('#fbCheck').addEventListener('click', async () => {
      try {
        const r = await spec.check(active);
        msg(r.loggedIn ? t('siStatusLoggedIn') : t('siStatusOffline'), r.loggedIn ? 'ok' : 'err');
      } catch (e) {
        msg(e.message, 'err');
      }
      load();
    });
    $('#fbAdd').addEventListener('click', async () => {
      const label = prompt(t('siLabel'));
      if (!label) return;
      try {
        const r = await post(spec.api.add, { label });
        if (r.error) throw new Error(r.error);
        await load();
      } catch (e) {
        msg(e.message, 'err');
      }
    });
    load();
  }

  function mount(root, ctx) {
    const t = ctx.t;
    const j = (u, o) => fetch(u, o).then((x) => x.json());
    const post = (u, b) =>
      j(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

    const spec = {
      t,
      kind: 'tiktok',
      goKey: 'tlStart',
      hintKey: 'tlValue',
      addHintKey: 'tlAccounts',
      needAccountKey: 'tlAccounts',
      accColKey: 'lgColAccount', // 这列在创作中心是「账号」，在卖家中心是「手机号 / 邮箱」
      actionLoginKey: 'siTabLogin', // 表格里那个「登录」按钮：别写成「登录卖家中心」
      // 登录方式：扫码 / 账密（卖家中心是直接开真实窗口，没有这一步）
      methods: [
        { id: 'qr', label: 'tlQr' },
        { id: 'password', label: 'tlPwd' },
      ],
      // 账号列与「添加账号」行两边保持同一版式，只是字段不同
      addFields: [{ id: 'label', ph: 'siLabel', required: true, w: 180 }],
      api: {
        list: '/api/tiktok-login/accounts',
        active: (id) => `/api/tiktok-login/accounts/${encodeURIComponent(id)}/active`,
        add: '/api/tiktok-login/accounts',
        logout: (id) => `/api/tiktok-login/accounts/${encodeURIComponent(id)}/logout`,
        del: (id) => `/api/tiktok-login/accounts/${encodeURIComponent(id)}?purge=1`,
        close: '/api/tiktok-login/close',
        state: '/api/tiktok-login/state',
        submit: '/api/tiktok-login/submit',
      },
      start: (p) => post('/api/tiktok-login/start', { mode: p.mode, account: p.id }),
      check: () => j('/api/tiktok-login/state'),
      onLoggedIn: ctx.onLoggedIn,
    };

    if (window.TTLoginUI && typeof window.TTLoginUI.mount === 'function') {
      return window.TTLoginUI.mount(root, spec);
    }
    return legacyPanel(root, ctx, spec);
  }

  window.TTModule.register({ id: 'tiktok-login', title: '创作中心登录', icon: '◎', mount });
})();


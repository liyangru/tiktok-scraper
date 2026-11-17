/* 卖家中心登录 —— 版式由核心的统一登录面板提供（与创作中心登录完全一致）
 *
 * 交互原则（用户明确要求）：
 *   · 登录 = 打开真实浏览器窗口登录，不在应用里塞表单
 *   · 首次（没有登录态）才弹窗；登录成功自动关窗；之后该账号一律无头运行
 *   · 每个账号一个独立浏览器档案，互不串号
 *   · **与创作中心登录同一套版式**（账号选择 / 登录态 / 多账号管理表格 / 操作按钮一一对应）
 */
(function () {
  const ESC = { '&': '&#38;', '<': '&#60;', '>': '&#62;', '"': '&#34;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  /**
   * 兼容旧版核心的降级面板。
   * ⚠️ 模块是单独分发的，完全可能出现「旧的 1.1.8 应用 + 新的 1.4.0 模块」这种组合；
   *    那种核心里还没有 window.TTLoginUI，这里必须还能完成登录，
   *    而不是把登录入口变成一句「版本过旧」的报错。
   */
  function legacyPanel(root, ctx, spec) {
    const t = ctx.t;
    const get = (u) => fetch(u, { cache: 'no-store' }).then((x) => x.json());
    const post = (u, b) =>
      fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then((x) => x.json());

    root.innerHTML = `
      <div class="si-row"><select id="fbAcc" class="si-select" style="flex:1;min-width:180px"></select></div>
      <div class="si-row">
        <button id="fbGo" class="btn-like primary">${esc(t(spec.goKey))}</button>
        <button id="fbCheck" class="btn-like">${esc(t('siCheckStatus'))}</button>
      </div>
      <div id="fbMsg" class="si-status"></div>
      <div class="si-hint">${esc(t(spec.hintKey))}</div>
      <div class="si-hint">${esc(t('siOpenWindowHint'))}</div>`;
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
      if (!active) return msg(t('siNoAccount'), 'err');
      msg(t('siOpeningWindow'), 'wait');
      try {
        const r = await spec.start({ mode: 'window', id: active, account: '' });
        if (r && r.error) throw new Error(r.error);
        msg((r && r.note) || t('siWindowOpened'), r && r.visible ? 'wait' : 'ok');
        setTimeout(load, 2000);
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
    load();
  }

  function mount(root, ctx) {
    const t = ctx.t;
    const j = (u, o) => fetch(u, o).then((x) => x.json());
    const post = (u, b) =>
      j(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

    const spec = {
      t,
      kind: 'seller',
      goKey: 'siStartLogin',
      hintKey: 'siAutoImportHint',
      addHintKey: 'siPwdOptional',
      needAccountKey: 'siNoAccount',
      idleKey: 'siOpenWindowHint',
      // 只有一个登录方式，但方式行照样渲染 —— 和创作中心那个面板逐行对齐（用户要求格式统一）
      methods: [{ id: 'window', label: 'siOpenWindowLogin' }],
      addFields: [
        { id: 'label', ph: 'siLabel', w: 130 },
        { id: 'account', ph: 'siAcc', required: true, w: 180 },
        { id: 'password', ph: 'siPwd', type: 'password', w: 150 },
        // 站点必须选对：泰国本地店与跨境全球店是两个域名，选错密码对也登不进去
        {
          id: 'site',
          type: 'select',
          w: 150,
          options: [
            { v: 'th', label: 'siSiteTh' },
            { v: 'global', label: 'siSiteGlobal' },
          ],
        },
      ],
      api: {
        list: '/api/seller-import/accounts',
        active: (id) => `/api/seller-import/accounts/${encodeURIComponent(id)}/active`,
        add: '/api/seller-import/accounts',
        logout: (id) => `/api/seller-import/accounts/${encodeURIComponent(id)}/logout`,
        del: (id) => `/api/seller-import/accounts/${encodeURIComponent(id)}`,
        patch: (id) => `/api/seller-import/accounts/${encodeURIComponent(id)}`,
        close: '/api/seller-import/close-browser',
      },
      // 登录 = 打开卖家中心真实窗口（后端负责识别登录成功并自动关窗）
      start: (p) => post(`/api/seller-import/accounts/${encodeURIComponent(p.id)}/login`, { visible: true }),
      // 快速校验（verify=0 只看档案里有没有登录态，不开浏览器）
      check: (id) =>
        j(`/api/seller-import/status?id=${encodeURIComponent(id)}&verify=0`).catch(() => ({ loggedIn: false })),
      onLoggedIn: ctx.onLoggedIn,
    };

    if (window.TTLoginUI && typeof window.TTLoginUI.mount === 'function') {
      return window.TTLoginUI.mount(root, spec);
    }
    return legacyPanel(root, ctx, spec);
  }

  window.TTModule.register({ id: 'seller-import', title: '卖家中心登录', icon: '⇪', mount });
})();

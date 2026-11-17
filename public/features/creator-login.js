/* 创作中心登录 —— 内置功能；版式由统一登录面板（public/js/login.js 的 TTLoginUI）提供 */
(function () {
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

    return window.TTLoginUI.mount(root, spec);
  }

  window.TTFeature.register({ id: 'tiktok-login', title: '创作中心登录', icon: '◎', mount });
})();


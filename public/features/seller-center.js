/* 卖家中心登录 —— 版式由核心的统一登录面板提供（与创作中心登录完全一致）
 *
 * 交互原则（用户明确要求）：
 *   · 登录 = 打开真实浏览器窗口登录，不在应用里塞表单
 *   · 首次（没有登录态）才弹窗；登录成功自动关窗；之后该账号一律无头运行
 *   · 每个账号一个独立浏览器档案，互不串号
 *   · **与创作中心登录同一套版式**（账号选择 / 登录态 / 多账号管理表格 / 操作按钮一一对应）
 */
(function () {
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

    return window.TTLoginUI.mount(root, spec);
  }

  window.TTFeature.register({ id: 'seller-import', title: '卖家中心登录', icon: '⇪', mount });
})();

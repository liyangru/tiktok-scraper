/* ============================================================
   登录与数据来源（内置功能，不再是可安装模块）

   - TTFeature：内置功能的前端注册表（public/features/*.js 在页面加载时注册自己）
   - TTLoginUI：创作中心 / 卖家中心共用的统一登录面板（两边同一版式）
   - TTLogin.open(id)：在应用内小窗里打开某个功能面板
   ============================================================ */
window.TTFeature = (() => {
  const regs = new Map();
  return {
    register(def) {
      regs.set(def.id, def);
    },
    get: (id) => regs.get(id),
  };
})();

/* ================= 统一登录面板（创作中心 / 卖家中心 共用同一版式） =================
   用户明确要求：两个登录入口的 UI 必须一样、格式统一。
   所以版式只写这一份，两个模块各自传入自己的接口实现（spec.api / spec.start）。
   结构：账号选择 + 登录态徽标 → 登录方式 → 状态区 → QR/表单 → 操作行 → 提示 → 多账号管理折叠表。
   两边**列与按钮完全一致**（备注 / 账号 / 登录态 / 最近登录 / 操作；登录 · 切换 · 退出 · 删除），
   只有「添加账号」那一行按各自需要的字段渲染（spec.addFields）。 */
window.TTLoginUI = (() => {
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const jget = (u) => fetch(API + u, { cache: 'no-store' }).then((x) => x.json());
  const jpost = (u, b) =>
    fetch(API + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then((x) =>
      x.json()
    );

  const fmtAt = (s) => (s ? String(s).slice(0, 16).replace('T', ' ') : '-');

  async function mount(root, spec) {
    const t = spec.t;
    const api = spec.api;
    const addFields = spec.addFields || [{ id: 'label', ph: 'siLabel' }];
    let accounts = [];
    let activeId = '';
    let timer = null;
    let mode = (spec.methods && spec.methods[0] && spec.methods[0].id) || '';

    root.innerHTML = `
      <div class="lg-bar">
        <select id="lgAcc" class="si-select"></select>
        <span id="lgState" class="lg-badge">—</span>
      </div>

      <div class="lg-tabs" id="lgTabs">
        ${(spec.methods || [])
          .map((m, i) => `<button data-m="${esc(m.id)}"${i === 0 ? ' class="on"' : ''}>${esc(t(m.label))}</button>`)
          .join('')}
      </div>

      <div class="lg-stage">
        <span class="lg-spin" id="lgSpin" style="display:none"></span>
        <span class="lg-msg" id="lgMsg"></span>
      </div>

      <div class="lg-qr" id="lgQr" style="display:none">
        <img id="lgQrImg" alt="QR">
        <div class="si-hint">${esc(t('tlQrTip'))}</div>
      </div>

      <div class="lg-form" id="lgForm" style="display:none">
        <input id="lgF1" class="si-select">
        <input id="lgF2" class="si-select" type="password" style="display:none">
        <button id="lgSubmit" class="btn-like primary">${esc(t('tlSubmit'))}</button>
      </div>

      <div class="lg-actions">
        <button id="lgGo" class="btn-like primary">${esc(t(spec.goKey || 'siStartLogin'))}</button>
        <button id="lgClose" class="btn-like">${esc(t('tlClose'))}</button>
        <button id="lgCheck" class="btn-like">${esc(t('siCheckStatus'))}</button>
      </div>

      <div class="si-hint" id="lgHint">${esc(t(spec.hintKey))}</div>

      <div class="si-fold">
        <button id="lgFold" class="si-fold-head">${esc(t('siTabAccounts'))}<span class="ar">▸</span></button>
        <div id="lgFoldBody" style="display:none"></div>
      </div>`;

    const $ = (s) => root.querySelector(s);
    const setMsg = (m, cls) => {
      const e = $('#lgMsg');
      if (!e) return;
      e.textContent = m || '';
      e.className = 'lg-msg' + (cls ? ' ' + cls : '');
    };
    const spin = (on) => {
      const e = $('#lgSpin');
      if (e) e.style.display = on ? 'inline-block' : 'none';
    };

    /* ---------------- 账号列表 ---------------- */
    const cur = () => accounts.find((a) => a.id === activeId) || accounts[0] || null;

    async function load() {
      const d = await jget(api.list).catch(() => ({ accounts: [] }));
      accounts = d.accounts || [];
      activeId = d.active || (accounts[0] && accounts[0].id) || '';
      renderBar();
      renderAccounts();
    }

    function renderBar() {
      const sel = $('#lgAcc');
      if (!sel) return;
      if (!accounts.length) {
        sel.innerHTML = `<option value="">${esc(t('siNoAccountYet'))}</option>`;
        sel.disabled = true;
      } else {
        sel.disabled = false;
        sel.innerHTML = accounts
          .map((a) => `<option value="${esc(a.id)}"${a.id === activeId ? ' selected' : ''}>${esc(a.label || a.account || a.id)}</option>`)
          .join('');
      }
      const a = cur();
      const badge = $('#lgState');
      if (badge) {
        const on = !!(a && a.hasSession);
        badge.textContent = t('siSession') + '：' + t(on ? 'siSessionYes' : 'siSessionNo');
        badge.className = 'lg-badge ' + (on ? 'ok' : 'err');
      }
    }

    /* ---------------- 多账号管理（两边列完全一致） ---------------- */
    function renderAccounts() {
      const box = $('#lgFoldBody');
      if (!box) return;
      box.innerHTML = `
        <div class="tbl-wrap"><table class="ec-table">
          <thead><tr>
            <th>${esc(t('siLabel'))}</th>
            <th>${esc(t(spec.accColKey || 'siAcc'))}</th>
            <th>${esc(t('siSession'))}</th>
            <th>${esc(t('siLastLogin'))}</th>
            <th>${esc(t('siAction'))}</th>
          </tr></thead>
          <tbody id="lgAccBody"></tbody>
        </table></div>
        <div class="si-row" style="margin-top:10px">
          ${addFields
            .map((f) =>
              f.type === 'select'
                ? `<select id="lgAdd_${esc(f.id)}" class="si-select" style="min-width:${f.w || 150}px">${(f.options || [])
                    .map((o) => `<option value="${esc(o.v)}">${esc(t(o.label))}</option>`)
                    .join('')}</select>`
                : `<input id="lgAdd_${esc(f.id)}" class="si-select" placeholder="${esc(t(f.ph))}"${
                    f.type ? ` type="${esc(f.type)}"` : ''
                  } style="min-width:${f.w || 140}px">`
            )
            .join('')}
          <button id="lgAddBtn" class="btn-like primary">${esc(t('siAddAccount'))}</button>
        </div>
        <div class="si-hint">${esc(t(spec.addHintKey || 'siPwdOptional'))}</div>
        ${api.patch ? `<div class="si-hint" style="margin-top:4px">${esc(t('siSiteHint'))}</div>` : ''}`;

      $('#lgAccBody').innerHTML = accounts.length
        ? accounts
            .map(
              (a) => `<tr>
            <td>${esc(a.label || '')}${a.id === activeId ? ' <b class="ok">·' + esc(t('siCurrent')) + '</b>' : ''}</td>
            <td>${esc(a.account || a.handle || a.label || a.id)}${
              a.site && api.patch
                ? ` <button class="lg-site" data-site="${esc(a.id)}" data-cur="${esc(a.site)}" title="${esc(
                    t('siSite')
                  )}">${esc(t(a.site === 'th' ? 'siSiteTh' : 'siSiteGlobal'))}</button>`
                : a.site
                ? ` <span class="lg-src">${esc(t(a.site === 'th' ? 'siSiteTh' : 'siSiteGlobal'))}</span>`
                : ''
            }</td>
            <td>${a.hasSession ? '<b class="ok">' + esc(t('siSessionYes')) + '</b>' : '<span class="err">' + esc(t('siSessionNo')) + '</span>'}</td>
            <td>${esc(fmtAt(a.lastLoginAt))}</td>
            <td>
              <button class="btn-like sm" data-act="login" data-id="${esc(a.id)}">${esc(t(spec.actionLoginKey || 'siLogin'))}</button>
              <button class="btn-like sm" data-act="switch" data-id="${esc(a.id)}">${esc(t('siSwitch'))}</button>
              <button class="btn-like sm" data-act="logout" data-id="${esc(a.id)}">${esc(t('siLogout'))}</button>
              <button class="btn-like sm danger" data-act="del" data-id="${esc(a.id)}">${esc(t('siDelete'))}</button>
            </td>
          </tr>`
            )
            .join('')
        : `<tr><td colspan="5" class="si-hint">${esc(t('siNoAccountYet'))}</td></tr>`;

      box.querySelectorAll('button[data-act]').forEach((b) =>
        b.addEventListener('click', async () => {
          const id = b.dataset.id;
          const act = b.dataset.act;
          const one = accounts.find((x) => x.id === id);
          b.disabled = true;
          try {
            if (act === 'login') {
              activeId = id;
              await jpost(api.active(id), {}).catch(() => {});
              await doLogin();
              return;
            }
            if (act === 'switch') await jpost(api.active(id), {});
            else if (act === 'logout') await jpost(api.logout(id), {});
            else if (act === 'del') {
              if (!confirm(t('siDeleteConfirm', { account: (one && (one.account || one.label)) || id }))) {
                b.disabled = false;
                return;
              }
              await fetch(API + api.del(id), { method: 'DELETE' }).catch(() => {});
            }
            await load();
            if (timer) poll();
          } catch (e) {
            setMsg(e.message, 'err');
          }
          b.disabled = false;
        })
      );

      // 站点标签可点：猜错了直接切（泰国本地店 / 跨境全球店是两个域名，选错密码对也登不进去）
      box.querySelectorAll('button.lg-site').forEach((b) =>
        b.addEventListener('click', async (e) => {
          e.stopPropagation();
          const next = b.dataset.cur === 'th' ? 'global' : 'th';
          try {
            await fetch(API + api.patch(b.dataset.site), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ site: next }),
            });
            await load();
          } catch (_) {}
        })
      );

      $('#lgAddBtn').addEventListener('click', async () => {
        const body = {};
        for (const f of addFields) {
          const el = $('#lgAdd_' + f.id);
          body[f.id] = el ? el.value.trim() : '';
        }
        const need = addFields.find((f) => f.required && !body[f.id]);
        if (need) return setMsg(t('siNeedAccPwd'), 'err');
        try {
          const r = await jpost(api.add, body);
          if (r.error) throw new Error(r.error);
          for (const f of addFields) {
            const el = $('#lgAdd_' + f.id);
            if (el) el.value = '';
          }
          await load();
        } catch (e) {
          setMsg(e.message, 'err');
        }
      });
    }

    /* ---------------- 登录方式切换 ---------------- */
    root.querySelectorAll('.lg-tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        mode = b.dataset.m;
        root.querySelectorAll('.lg-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      })
    );

    /* ---------------- 状态渲染（创作中心 / 卖家中心 同一套外观） ---------------- */
    function renderState(s) {
      const busy = ['launching', 'loading'].includes(s.phase);
      const needInput = s.phase === 'need-input';
      spin(busy || s.phase === 'waiting-scan' || s.phase === 'scanned');
      $('#lgGo').disabled = busy;

      const showQr = !!s.qr;
      $('#lgQr').style.display = showQr ? 'block' : 'none';
      if (showQr) $('#lgQrImg').src = 'data:image/png;base64,' + s.qr;
      $('#lgForm').style.display = needInput ? 'flex' : 'none';

      if (needInput) {
        const kind = s.inputKind;
        const f1 = $('#lgF1');
        const f2 = $('#lgF2');
        if (kind === 'account') {
          f1.style.display = 'block';
          f1.placeholder = t('siAcc');
          f2.style.display = 'block';
          f2.placeholder = t('siPwd');
        } else if (kind === 'password') {
          f1.style.display = 'none';
          f2.style.display = 'block';
          f2.placeholder = t('siPwd');
        } else {
          f1.style.display = 'block';
          f1.placeholder = t('tlCodePlaceholder');
          f2.style.display = 'none';
        }
      }

      let text = s.message || '';
      let cls = '';
      if (s.phase === 'logged-in') {
        text = s.message || t('tlOk');
        cls = 'ok';
        spin(false);
      } else if (s.phase === 'error') cls = 'err';
      else if (s.phase === 'waiting-scan' || s.phase === 'scanned') cls = 'wait';
      else if (s.phase === 'idle') text = t('tlIdle');
      setMsg(text, cls);

      if (s.phase === 'logged-in' && !s.saved && !root.dataset.syncFired) {
        root.dataset.syncFired = '1';
        if (typeof spec.onLoggedIn === 'function') setTimeout(() => spec.onLoggedIn(), 400);
      }
      if (['logged-in', 'error', 'idle'].includes(s.phase) && timer && s.phase !== 'logged-in') {
        clearInterval(timer);
        timer = null;
      }
    }

    async function poll() {
      if (!api.state) return;
      try {
        const s = await jget(api.state);
        renderState(s);
        if (s.loggedIn && !s.saved && !root.dataset.syncFired) {
          root.dataset.syncFired = '1';
          if (typeof spec.onLoggedIn === 'function') setTimeout(() => spec.onLoggedIn(), 400);
        }
        if (s.phase === 'logged-in' && timer) {
          // 登录成功后再刷一次账号（handle 是这时才写进注册表的）
          setTimeout(load, 1200);
        }
      } catch (_) {}
    }

    function startPolling() {
      if (!api.state) return;
      if (timer) clearInterval(timer);
      timer = setInterval(poll, 1500);
      poll();
    }

    /* ---------------- 主操作 ---------------- */
    async function doLogin() {
      const a = cur();
      if (!a) {
        // 还没有账号：直接把「多账号管理」展开，别让用户点了半天没反应
        const body = $('#lgFoldBody');
        if (body && body.style.display === 'none') $('#lgFold').click();
        setMsg(spec.needAccountKey ? t(spec.needAccountKey) : t('siNoAccount'), 'err');
        return;
      }
      root.dataset.syncFired = '';
      setMsg(t('tlStarting'), 'wait');
      spin(true);
      try {
        const r = await spec.start({ mode, id: a ? a.id : '', account: a ? a.account : '' });
        if (r && r.error) throw new Error(r.error);
        if (r && r.note) setMsg(r.note + (r.visible ? ' ' + t('siWindowOpened') : ''), r.visible ? 'wait' : 'ok');
        if (api.state) startPolling();
        setTimeout(load, 1500);
        if (r && r.visible && typeof spec.onLoggedIn === 'function') {
          // 卖家中心开的是真实窗口：登录成功后由后端记录时间，前端稍后刷新
          setTimeout(async () => {
            await load();
            if (typeof spec.onLoggedIn === 'function') spec.onLoggedIn();
          }, 2500);
        }
      } catch (e) {
        setMsg(e.message, 'err');
        spin(false);
      }
    }

    $('#lgGo').addEventListener('click', doLogin);

    $('#lgSubmit').addEventListener('click', async () => {
      if (!api.submit) return;
      const b = {};
      const v1 = $('#lgF1').value.trim();
      const v2 = $('#lgF2').value;
      if ($('#lgF2').style.display !== 'none' && v2) {
        b.account = v1;
        b.password = v2;
      } else if (v1) {
        b.code = v1;
      }
      try {
        const r = await jpost(api.submit, b);
        if (r.error) throw new Error(r.error);
        $('#lgF1').value = '';
        $('#lgF2').value = '';
        setMsg(t('tlSubmitted'), 'wait');
        startPolling();
      } catch (e) {
        setMsg(e.message, 'err');
      }
    });

    $('#lgClose').addEventListener('click', async () => {
      await jpost(api.close, {}).catch(() => {});
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      root.dataset.syncFired = '';
      spin(false);
      $('#lgQr').style.display = 'none';
      $('#lgForm').style.display = 'none';
      setMsg(t('tlIdle'));
      await load();
    });

    $('#lgCheck').addEventListener('click', async () => {
      setMsg(t('siChecking'));
      try {
        const r = await spec.check(cur() ? cur().id : '');
        setMsg(r.loggedIn ? t('siStatusLoggedIn') : t('siStatusOffline'), r.loggedIn ? 'ok' : 'err');
      } catch (e) {
        setMsg(e.message, 'err');
      }
      await load();
    });

    $('#lgAcc').addEventListener('change', async () => {
      activeId = $('#lgAcc').value;
      await jpost(api.active(activeId), {}).catch(() => {});
      renderBar();
      renderAccounts();
      if (api.state) poll();
    });

    const fold = $('#lgFold');
    fold.addEventListener('click', () => {
      const body = $('#lgFoldBody');
      const open = body.style.display === 'none';
      body.style.display = open ? '' : 'none';
      fold.classList.toggle('on', open);
      fold.querySelector('.ar').textContent = open ? '▾' : '▸';
    });

    await load();
    if (api.state) poll(); // 进面板先看一次当前状态（可能是上次留下的登录态）
    else setMsg(t(spec.idleKey || 'tlIdle'));
  }

  return { mount };
})();

const TTLogin = (() => {
  const TITLES = { 'tiktok-login': 'loginCreator', 'seller-import': 'loginSeller', 'seller-api': 'sellerApiTitle' };

  function open(id) {
    const reg = window.TTFeature.get(id);
    $('#loginTitle').textContent = t(TITLES[id] || 'loginTitle');
    const body = $('#loginBody');
    body.innerHTML = '';
    body.dataset.syncFired = '';
    openModal('loginModal');
    if (!reg || typeof reg.mount !== 'function') {
      body.innerHTML = `<div class="notice err"><span>${esc(t('featureMissing'))}</span></div>`;
      return;
    }
    try {
      reg.mount(body, { t, loginOnly: true, onLoggedIn: () => autoSync(id) });
    } catch (e) {
      body.innerHTML = `<div class="notice err"><span>${esc(e.message)}</span></div>`;
    }
  }

  /** 登录成功后自动导入数据；失败给出原因和「重试」按钮 */
  async function autoSync(id) {
    const endpoint = id === 'seller-import' ? '/api/seller-import/login-sync' : '/api/tiktok-login/sync-now';
    const host = $('#loginBody');
    const badge = document.createElement('div');
    badge.className = 'sync-badge';
    if (host) host.appendChild(badge);
    const run = async () => {
      badge.innerHTML = `<span class="spinner xs"></span><span>${esc(t('syncAfterLogin'))}</span>`;
      try {
        const r = await jpost(endpoint);
        if (r.ok === false) throw new Error(r.error || t('noData'));
        const n = r.n != null ? r.n : r.matched;
        badge.innerHTML = `<span class="ok">✓ ${esc(t('syncOkN', { n: n || 0 }))}</span>`;
        toast(t('syncOkN', { n: n || 0 }), 'ok');
        TTApp.refreshSync();
      } catch (e) {
        badge.innerHTML = `<span class="err">${esc(t('syncFailed', { err: e.message }))}</span> `;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn xs';
        b.textContent = t('retrySync');
        b.addEventListener('click', run);
        badge.appendChild(b);
      }
    };
    run();
  }

  function init() {
    const m = $('#loginModal');
    m._onClose = () => {
      $('#loginBody').innerHTML = '';
    };
  }

  return { open, init };
})();

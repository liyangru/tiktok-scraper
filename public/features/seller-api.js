/* 开放平台数据（Partner API）—— 配置 → 授权 → 拉数据 */
(function () {
  const ESC = { '&': '&#38;', '<': '&#60;', '>': '&#62;', '"': '&#34;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  function mount(root, ctx) {
    const t = ctx.t;
    const j = (u, o) => fetch(u, o).then((x) => x.json());
    const post = (u, b) =>
      j(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

    root.innerHTML = `
      <div class="si-hint" style="margin-bottom:10px">${esc(t('saHint'))}</div>

      <div class="si-fold">
        <button id="saFoldCfg" class="si-fold-head">${esc(t('saCfgTitle'))}<span class="ar">▾</span></button>
        <div id="saBodyCfg">
          <div class="si-row" style="margin-top:10px">
            <input id="saKey" class="si-select" placeholder="${esc(t('saAppKey'))}" style="flex:1;min-width:170px">
            <input id="saSecret" class="si-select" type="password" placeholder="${esc(t('saAppSecret'))}" style="flex:1;min-width:170px">
            <input id="saService" class="si-select" placeholder="${esc(t('saServiceId'))}" style="min-width:200px">
            <button id="saSave" class="btn-like primary">${esc(t('saSave'))}</button>
          </div>
          <div class="si-status" id="saCfgState"></div>
        </div>
      </div>

      <div class="si-fold">
        <button id="saFoldAuth" class="si-fold-head">${esc(t('saAuthTitle'))}<span class="ar">▾</span></button>
        <div id="saBodyAuth" style="display:none">
          <div class="si-status" id="saAuthState" style="margin-top:10px"></div>
          <div class="si-row">
            <button id="saAuthGo" class="btn-like primary">${esc(t('saAuthStart'))}</button>
            <button id="saAuthOpen" class="btn-like">${esc(t('saAuthOpen'))}</button>
            <button id="saRefresh" class="btn-like">${esc(t('saRefresh'))}</button>
          </div>
          <div class="si-row">
            <input id="saCode" class="si-select" placeholder="${esc(t('saPasteCode'))}" style="flex:1;min-width:240px">
            <button id="saCodeGo" class="btn-like">${esc(t('saSubmitCode'))}</button>
          </div>
          <div class="si-status" id="saAuthMsg"></div>
        </div>
      </div>

      <div class="si-fold">
        <button id="saFoldData" class="si-fold-head">${esc(t('saDataTitle'))}<span class="ar">▸</span></button>
        <div id="saBodyData" style="display:none">
          <div class="si-status" id="saShopState" style="margin-top:10px"></div>
          <div class="si-row">
            <button id="saShops" class="btn-like">${esc(t('saFetchShops'))}</button>
            <input id="saDays" class="si-select" value="7" style="width:70px" title="${esc(t('saDays'))}">
            <button id="saPull" class="btn-like primary">${esc(t('saPull'))}</button>
          </div>
          <div class="si-status" id="saDataMsg"></div>
          <div class="si-hint" id="saSelf"></div>
        </div>
      </div>

      <div class="si-fold">
        <button id="saFoldDiag" class="si-fold-head">${esc(t('saDiag'))}<span class="ar">▸</span></button>
        <div id="saBodyDiag" style="display:none">
          <div class="si-row" style="margin-top:10px">
            <input id="saPath" class="si-select" placeholder="${esc(t('saPath'))}" style="flex:1;min-width:260px" value="/authorization/202309/shops">
            <button id="saCall" class="btn-like">${esc(t('saCall'))}</button>
          </div>
          <div class="si-row">
            <input id="saParams" class="si-select" placeholder="${esc(t('saParams'))}" style="flex:1;min-width:260px">
          </div>
          <pre id="saRaw" class="sa-raw"></pre>
        </div>
      </div>`;

    const $ = (s) => root.querySelector(s);
    const msg = (sel, m, cls) => {
      const e = $(sel);
      if (e) { e.textContent = m || ''; e.className = 'si-status' + (cls ? ' ' + cls : ''); }
    };

    // 折叠开关
    [['saFoldCfg', 'saBodyCfg'], ['saFoldAuth', 'saBodyAuth'], ['saFoldData', 'saBodyData'], ['saFoldDiag', 'saBodyDiag']].forEach(
      ([head, body]) => {
        const h = $('#' + head);
        const b = $('#' + body);
        if (!h || !b) return;
        h.addEventListener('click', () => {
          const open = b.style.display === 'none';
          b.style.display = open ? '' : 'none';
          h.classList.toggle('on', open);
          const ar = h.querySelector('.ar');
          if (ar) ar.textContent = open ? '▾' : '▸';
        });
      }
    );

    /* ---------------- 状态 ---------------- */
    let last = null;
    async function loadStatus() {
      try {
        last = await j('/api/seller-api/status');
      } catch (_) {
        last = null;
      }
      if (!last) return;
      const c = last.configured || {};
      msg('#saCfgState',
        `${t('saAppKey')} ${c.appKey ? '✓' : '✗'} · ${t('saAppSecret')} ${c.appSecret ? '✓' : '✗'} · ${t('saServiceId')} ${c.serviceId ? '✓' : '✗'}`,
        c.appKey && c.appSecret && c.serviceId ? 'ok' : '');
      if (last.appKeyTail) $('#saKey').placeholder = `${t('saAppKey')} ····${last.appKeyTail}`;
      if (last.serviceId) $('#saService').placeholder = `${t('saServiceId')} ····${last.serviceId.slice(-6)}`;

      const tok = last.token;
      if (!last.authorized) msg('#saAuthState', t('saAuthIdle'), 'err');
      else if (tok.expired) msg('#saAuthState', t('saTokenExpired'), 'err');
      else msg('#saAuthState', `${t('saAuthOk')} · ${tok.seller || ''} ${tok.region || ''} · ${t('saTokenLeft', { h: Math.max(0, Math.round(tok.expiresIn / 3600)) })}`, 'ok');

      msg('#saShopState',
        last.shop ? `${t('saShopTitle')}：${last.shop.name || last.shop.id}（${last.shop.region || ''}）cipher ····${String(last.shop.cipher || '').slice(-6)}`
                  : t('saShopNone'),
        last.shop ? 'ok' : '');
      msg('#saDataMsg', t('saPulled', { n: last.videos || 0 }));
    }

    /* ---------------- 配置 ---------------- */
    $('#saSave').addEventListener('click', async () => {
      const b = { appKey: $('#saKey').value.trim(), appSecret: $('#saSecret').value.trim(), serviceId: $('#saService').value.trim() };
      if (!b.appKey && !b.appSecret && !b.serviceId) return msg('#saCfgState', t('saNeedFill'), 'err');
      try {
        const r = await post('/api/seller-api/config', b);
        if (r.error) throw new Error(r.error);
        $('#saSecret').value = '';
        msg('#saCfgState', t('saCfgOk'), 'ok');
        await loadStatus();
      } catch (e) {
        msg('#saCfgState', e.message, 'err');
      }
    });

    /* ---------------- 授权 ---------------- */
    let authTimer = null;
    async function pollAuth() {
      try {
        const s = await j('/api/seller-api/authorize/state');
        if (s.message) msg('#saAuthMsg', s.message, s.phase === 'done' ? 'ok' : s.phase === 'error' ? 'err' : '');
        if (s.phase === 'done' || s.phase === 'error' || s.phase === 'idle') {
          if (authTimer) { clearInterval(authTimer); authTimer = null; }
          if (s.phase === 'done') await loadStatus();
        }
      } catch (_) {}
    }
    $('#saAuthGo').addEventListener('click', async () => {
      msg('#saAuthMsg', t('saAuthOpening'), '');
      try {
        const r = await post('/api/seller-api/authorize/start', {});
        if (r.error) throw new Error(r.error);
        if (authTimer) clearInterval(authTimer);
        authTimer = setInterval(pollAuth, 1500);
        pollAuth();
      } catch (e) {
        msg('#saAuthMsg', e.message, 'err');
      }
    });
    $('#saAuthOpen').addEventListener('click', async () => {
      const url = last && last.authorizeUrl;
      if (!url) return msg('#saAuthMsg', t('saNeedServiceId'), 'err');
      window.open(url, '_blank', 'noopener');
      msg('#saAuthMsg', url, '');
    });
    $('#saCodeGo').addEventListener('click', async () => {
      const code = $('#saCode').value.trim();
      if (!code) return msg('#saAuthMsg', t('saPasteCode'), 'err');
      msg('#saAuthMsg', t('saAuthOpening'), '');
      try {
        const r = await post('/api/seller-api/authorize/code', { code });
        if (r.error) throw new Error(r.error);
        $('#saCode').value = '';
        msg('#saAuthMsg', t('saAuthOk'), 'ok');
        await loadStatus();
      } catch (e) {
        msg('#saAuthMsg', e.message, 'err');
      }
    });
    $('#saRefresh').addEventListener('click', async () => {
      try {
        const r = await post('/api/seller-api/refresh', {});
        if (r.error) throw new Error(r.error);
        msg('#saAuthMsg', t('saAuthOk'), 'ok');
        await loadStatus();
      } catch (e) {
        msg('#saAuthMsg', e.message, 'err');
      }
    });

    /* ---------------- 店铺 / 数据 ---------------- */
    $('#saShops').addEventListener('click', async () => {
      msg('#saShopState', t('saLoading'), '');
      try {
        const r = await post('/api/seller-api/shops', {});
        if (r.error || r.ok === false) throw new Error(r.error || t('saNoData'));
        msg('#saShopState', t('saShopsFound', { n: (r.shops || []).length }), 'ok');
        await loadStatus();
      } catch (e) {
        msg('#saShopState', e.message, 'err');
      }
    });
    $('#saPull').addEventListener('click', async () => {
      msg('#saDataMsg', t('saPulling'), '');
      try {
        const r = await post('/api/seller-api/sync', { days: Number($('#saDays').value) || 7 });
        if (r.error || r.ok === false) throw new Error(r.error || t('saNoData'));
        msg('#saDataMsg', t('saPullOk', { n: r.n, from: r.start, to: r.end }) + ' · ' + (r.pages || []).join(' / '), 'ok');
        await loadStatus();
      } catch (e) {
        msg('#saDataMsg', e.message, 'err');
      }
    });

    /* ---------------- 诊断 ---------------- */
    $('#saCall').addEventListener('click', async () => {
      let params = {};
      const raw = $('#saParams').value.trim();
      if (raw) {
        try { params = JSON.parse(raw); } catch (e) { return msg('#saDataMsg', 'params 不是合法 JSON', 'err'); }
      }
      $('#saRaw').textContent = t('saLoading');
      try {
        const r = await post('/api/seller-api/call', { path: $('#saPath').value.trim(), params });
        $('#saRaw').textContent = JSON.stringify(r, null, 2).slice(0, 6000);
      } catch (e) {
        $('#saRaw').textContent = e.message;
      }
    });

    /* ---------------- 签名自检 ---------------- */
    (async () => {
      try {
        const r = await j('/api/seller-api/selftest');
        msg('#saSelf', `${t('saSelftest')}：${r.ok ? '✅ ' + t('saSelftestOk') : '❌ ' + t('saSelftestBad')}`, r.ok ? 'ok' : 'err');
      } catch (_) {}
    })();

    loadStatus();
    pollAuth();
  }

  window.TTFeature.register({ id: 'seller-api', title: '开放平台数据（API）', icon: '⚡', mount });
})();

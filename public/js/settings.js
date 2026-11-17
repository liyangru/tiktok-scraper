/* ============================================================
   设置：账号登录 / 数据来源 / 存储位置 / AI 接口 / 应用更新
   （2.1 起没有「模块」：所有功能都内置，设置页只放普通用户需要的基础设置）
   ============================================================ */
const TTSettings = (() => {
  let lastUpdate = null;

  function open() {
    openModal('settingsModal');
    loadStorage();
    loadAi();
  }

  /* ---------------- 存储位置 ---------------- */
  async function loadStorage() {
    const pick = $('#storagePick');
    const input = $('#storageDir');
    pick.innerHTML = `<span class="spinner xs"></span>`;
    try {
      const d = await jget('/api/settings/storage');
      input.value = d.custom ? d.downloadDir : '';
      pick.textContent = d.custom ? d.downloadDir : `${t('storageDefault')} · ${d.downloadDir}`;
      pick.title = d.downloadDir;
    } catch (e) {
      pick.textContent = e.message;
    }
  }
  async function saveDir(dir) {
    await jpost('/api/settings/storage', { downloadDir: dir });
    toast(t('storageSaved'), 'ok');
    await loadStorage();
  }

  /* ---------------- AI 接口 ---------------- */
  async function loadAi() {
    try {
      const d = await jget('/api/settings/llm');
      $('#aiBase').value = d.base || '';
      $('#aiModel').value = d.model || 'auto-ops';
      $('#aiVision').value = d.vision || '';
      const k = $('#aiKey');
      k.value = '';
      k.placeholder = d.hasKey ? `${t('aiKeySet')} · ${d.keyHint || ''}` : t('aiKey');
      setAiState(d.configured);
    } catch (_) {}
  }
  function setAiState(configured) {
    const was = state.aiConfigured;
    state.aiConfigured = !!configured;
    const el = $('#aiState');
    if (el) {
      el.className = 'pill ' + (configured ? 's-done' : 's-queued');
      el.textContent = t(configured ? 'aiConfigured' : 'aiNotConfigured');
    }
    if (was !== state.aiConfigured && state.job) TTResults.render();
  }
  async function checkAi() {
    try {
      const d = await jget('/api/settings/llm');
      setAiState(d.configured);
    } catch (_) {}
  }

  /* ---------------- 应用更新 ---------------- */
  function renderUpdate(d) {
    const el = $('#upState');
    const btn = $('#upInstall');
    lastUpdate = d;
    if (!d) return;
    if (d.error) {
      el.className = 'status err';
      el.textContent = t('upFailed', { err: d.error });
      btn.hidden = true;
      return;
    }
    el.className = 'status ' + (d.hasUpdate ? 'ok' : '');
    el.textContent = d.hasUpdate ? t('upAvailable', { v: d.latest, cur: d.current }) : t('upUpToDate', { v: d.current });
    btn.hidden = !(d.hasUpdate && (d.setup || d.portable));
  }

  function init() {
    $('#settingsBtn').addEventListener('click', open);
    $('#settingsModal').addEventListener('click', (e) => {
      const f = e.target.closest('[data-feature]');
      if (f) {
        closeModal('settingsModal');
        TTLogin.open(f.dataset.feature);
      }
      if (e.target.closest('[data-seller-upload]')) {
        closeModal('settingsModal');
        $('#sellerStatus').textContent = '';
        $('#sellerFile').value = '';
        openModal('sellerModal');
      }
    });

    // 存储：点路径框 → 系统文件夹选择器；浏览器开发模式没有原生对话框 → 退回输入框
    $('#storagePick').addEventListener('click', async () => {
      const input = $('#storageDir');
      try {
        const r = await jpost('/api/settings/storage/pick', { from: input.value });
        if (r.canceled) return;
        if (!r.ok) {
          input.hidden = false;
          input.focus();
          return toast(t('storageInputHint'), 'warn');
        }
        await saveDir(r.dir);
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    $('#storageDir').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveDir(e.target.value.trim()).catch((err) => toast(err.message, 'err'));
      }
    });
    $('#storageReset').addEventListener('click', async (e) => {
      const done = btnBusy(e.currentTarget);
      try {
        $('#storageDir').value = '';
        $('#storageDir').hidden = true;
        await saveDir('');
        toast(t('storageResetDone'), 'ok');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        done();
      }
    });
    $('#storageOpen').addEventListener('click', () => jpost('/api/settings/storage/open').catch((e) => toast(e.message, 'err')));

    $('#aiSave').addEventListener('click', async (e) => {
      const done = btnBusy(e.currentTarget);
      try {
        const body = { base: $('#aiBase').value.trim(), model: $('#aiModel').value.trim() || 'auto-ops', vision: $('#aiVision').value.trim() };
        const k = $('#aiKey').value.trim();
        if (k) body.key = k; // 不填 = 保持原密钥
        await jpost('/api/settings/llm', body);
        toast(t('aiSaved'), 'ok');
        await loadAi();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        done();
      }
    });
    $('#aiTest').addEventListener('click', async (e) => {
      const st = $('#aiStatus');
      const done = btnBusy(e.currentTarget, t('aiTesting'));
      st.className = 'status';
      st.textContent = '';
      try {
        const r = await jpost('/api/settings/llm/test');
        st.className = 'status ok';
        st.textContent = t('aiTestOk', { ms: r.ms });
      } catch (err) {
        st.className = 'status err';
        st.textContent = err.message;
      } finally {
        done();
      }
    });

    $('#upCheck').addEventListener('click', async (e) => {
      const done = btnBusy(e.currentTarget, t('upChecking'));
      try {
        renderUpdate(await jget('/api/update/check?force=1'));
      } catch (err) {
        renderUpdate({ error: err.message });
      } finally {
        done();
      }
    });
    $('#upInstall').addEventListener('click', async (e) => {
      const el = $('#upState');
      const done = btnBusy(e.currentTarget, t('upInstalling'));
      try {
        await jpost('/api/update/download', { install: !!lastUpdate && !!lastUpdate.setup });
        el.className = 'status ok';
        el.textContent = t('upInstalled');
      } catch (err) {
        el.className = 'status err';
        el.textContent = t('upFailed', { err: err.message });
      } finally {
        done();
      }
    });

    // 卖家中心导出的 xlsx 手动导入
    $('#sellerFile').addEventListener('change', async () => {
      const f = $('#sellerFile').files && $('#sellerFile').files[0];
      const st = $('#sellerStatus');
      if (!f) return;
      st.className = 'status';
      st.innerHTML = `<span class="spinner xs"></span> ${esc(t('sellerUploading'))}`;
      try {
        const buf = await f.arrayBuffer();
        const r = await api('/api/seller-import/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
        st.className = 'status ok';
        st.textContent = t('sellerImported', { n: r.count, range: r.dateRange || '' });
        TTApp.refreshSync();
      } catch (e) {
        st.className = 'status err';
        st.textContent = e.message;
      }
    });

    checkAi();
  }

  return { init, open, checkAi };
})();

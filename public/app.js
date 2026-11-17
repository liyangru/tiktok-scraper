/* ============================================================
   TikTok Scraper · 主流程（中 / 泰 / 英三语）
   负责：语言、浏览器状态、抓取任务（开始 / 停止 / 轮询）、历史任务、导出、窗口控制。
   各区域的渲染在 public/js/*.js，日期与指标口径在 public/shared/*.js（前后端共用）。
   ============================================================ */
const TTApp = (() => {
  let pollTimer = 0;
  let pollFails = 0;
  let lastHealth = null;
  let history = [];

  /* ---------------- 语言 ---------------- */
  function applyLang(lang) {
    window.currentLang = lang;
    try {
      localStorage.setItem('lang', lang);
    } catch (_) {}
    // 同步给主进程：下次启动的闪屏用同一种语言
    jpost('/api/settings/core', { lang }).catch(() => {});
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
    $$('.lang-switch button').forEach((b) => {
      const on = b.dataset.lang === lang;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    $$('[data-i18n]').forEach((el) => {
      const v = t(el.dataset.i18n);
      if (el.dataset.i18nHtml === '1') el.innerHTML = v;
      else el.textContent = v;
    });
    $$('[data-i18n-ph]').forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
    $$('[data-i18n-tip]').forEach((el) => {
      el.dataset.tip = t(el.dataset.i18nTip);
      el.setAttribute('aria-label', el.dataset.tip);
    });
    $$('[data-i18n-title]').forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
      el.setAttribute('aria-label', el.title);
    });
    document.title = t('title');
    TTFilter.relabel();
    renderStartBtn();
    renderBrowserChip();
    renderHistory();
    renderQuickAcc();
    TTSettings.checkAi();
    if (state.task) TTProgress.render(state.task);
    if (state.job) TTResults.render();
  }

  /* ---------------- 浏览器 / 运行状态 ---------------- */
  async function checkHealth() {
    try {
      lastHealth = await jget('/api/health');
    } catch (e) {
      lastHealth = { error: e.message };
    }
    renderBrowserChip();
    const v = $('#appVer');
    if (v && lastHealth && lastHealth.version) v.textContent = `v${lastHealth.version}`;
  }
  function renderBrowserChip() {
    const el = $('#browserChip');
    if (!el) return;
    const h = lastHealth;
    if (!h) {
      el.className = 'chip';
      el.innerHTML = `<span class="spinner xs"></span><span>${esc(t('checking'))}</span>`;
    } else if (h.error) {
      el.className = 'chip bad';
      el.innerHTML = `<span class="dot"></span><span>${esc(t('serviceDown'))}</span>`;
      el.title = h.error;
    } else if (h.chromeFound) {
      el.className = 'chip ok';
      el.innerHTML = `<span class="dot"></span><span>${esc(t('browserReadyShort'))}</span>`;
      el.title = t('browserReady', { name: (h.chrome || '').split(/[\\/]/).pop() || 'chromium' });
    } else {
      el.className = 'chip bad';
      el.innerHTML = `<span class="dot"></span><span>${esc(t('noBrowserShort'))}</span>`;
      el.title = t('noBrowser').replace(/<[^>]+>/g, '');
    }
  }

  function renderStartBtn() {
    const b = $('#startBtn');
    const s = $('#stopBtn');
    const running = state.busy;
    b.disabled = running;
    b.innerHTML = running ? `<span class="spinner sm light"></span><span>${esc(t('scraping'))}</span>` : esc(t('start'));
    s.hidden = !running;
    const stopping = state.task && state.task.status === 'stopping';
    s.disabled = !!stopping;
    s.innerHTML = stopping ? `<span class="spinner sm"></span><span>${esc(t('stopping'))}</span>` : esc(t('stop'));
    const chip = $('#runChip');
    if (chip) {
      chip.hidden = !running;
      chip.textContent = running ? t('runChip') : '';
    }
  }

  /* ---------------- 抓取 ---------------- */
  function handlesValue() {
    return $('#handles').value;
  }

  async function start(params) {
    if (state.busy) return;
    const f = TTFilter.snapshot();
    const body = params || {
      handles: handlesValue(),
      from: f.from,
      to: f.to,
      compareMode: f.compare ? f.mode : 'none',
      compareFrom: f.mode === 'custom' ? f.cmpFrom : undefined,
      compareTo: f.mode === 'custom' ? f.cmpTo : undefined,
    };
    if (!String(body.handles || '').trim() && !(Array.isArray(body.handles) && body.handles.length)) {
      toast(t('needUsername'), 'err');
      $('#handles').focus();
      return;
    }
    if (f.mode === 'custom' && !f.compare && !params) {
      toast(t('cmpCustomNeed'), 'err');
      return;
    }
    state.busy = true;
    state.job = null;
    state.rows = [];
    $('#results').hidden = true;
    renderStartBtn();
    TTProgress.reset();
    TTTable.reset();
    // 立刻给出反馈：任务面板先显示「正在初始化」，不等第一次轮询
    const handles = (Array.isArray(body.handles) ? body.handles : String(body.handles).split(/[\n,，;；\s]+/)).map((x) => x.trim().replace(/^@/, '')).filter(Boolean);
    TTProgress.render({
      status: 'queued',
      stage: 'init',
      handles,
      accounts: handles.map((h) => ({ handle: h, state: 'queued' })),
      createdAt: new Date().toISOString(),
      from: body.from,
      to: body.to,
      events: [],
    });
    // 右栏给出等待中的空状态，而不是一片空白
    $('#emptyState').hidden = false;
    $('#emptyTitle').innerHTML = `<span class="spin"></span> ${esc(t('emptyScraping'))}`;
    $('#emptySub').innerHTML = `<div class="empty-progress" id="emptyProgress"><i></i></div><span>${esc(t('emptyScrapingSub2'))}</span>`;
    try {
      const r = await jpost('/api/scrape', body);
      state.jobId = r.id;
      poll();
    } catch (e) {
      state.busy = false;
      renderStartBtn();
      TTProgress.render({
        status: 'error',
        stage: 'error',
        error: e.message,
        handles,
        accounts: [],
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        events: [],
        _params: body,
      });
      toast(t('submitFailed', { msg: e.message }), 'err');
      $('#emptyTitle').textContent = t('emptyTitle');
      $('#emptySub').textContent = t('emptySub');
    }
  }

  /** 右栏空状态里的进度条：与左栏共用同一套百分比算法 */
  function updateEmptyProgress(j) {
    const bar = document.getElementById('emptyProgress');
    if (!bar) return;
    const acc = j.accounts || [];
    let pct = 0;
    if (acc.length) {
      const frac = (a) => {
        if (['done','failed','stopped'].includes(a.state)) return 1;
        if (a.state === 'queued') return 0;
        switch (a.stage) {
          case 'open': return 0.05;
          case 'profile': return 0.1;
          case 'scroll': return 0.14 + 0.78 * (typeof a.cover === 'number' ? a.cover : 0);
          case 'filter': return 0.95;
          default: return 0.02;
        }
      };
      pct = Math.round(acc.reduce((s,a)=>s+frac(a),0)/acc.length*100);
    }
    const i = bar.querySelector('i');
    if (i) i.style.width = pct + '%';
    const sub = document.getElementById('emptySub');
    if (sub) {
      const done = acc.filter(a=>a.state==='done').length;
      sub.lastChild && (sub.lastChild.textContent = `${done}/${acc.length || (j.handles||[]).length} 个账号 · ${pct}% · 结果实时汇总中`);
    }
  }

  /** 失败 / 停止后的「重试」：用同一组参数重新提交 */
  function rerun(job) {
    if (job._params) return start(job._params);
    start({
      handles: job.handles,
      from: job.currentFrom || job.from,
      to: job.currentTo || job.to,
      compareMode: job.compareMode || 'none',
      compareFrom: job.compareMode === 'custom' ? job.compareFrom : undefined,
      compareTo: job.compareMode === 'custom' ? job.compareTo : undefined,
    });
  }

  async function stop() {
    if (!state.jobId) return;
    $('#stopBtn').disabled = true;
    try {
      await jpost(`/api/jobs/${encodeURIComponent(state.jobId)}/stop`);
      if (state.task) state.task.status = 'stopping';
      renderStartBtn();
      if (state.task) TTProgress.render(state.task);
    } catch (e) {
      $('#stopBtn').disabled = false;
      toast(e.message, 'err');
    }
  }

  function clearPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = 0;
  }

  /**
   * 轮询任务状态。
   * - 网络短暂失败：继续重试，并在面板上提示「正在重连」；连续失败太久则停止并给出重试入口，绝不无限转圈
   * - 任务结束（完成 / 停止 / 失败 / 中断）：停止动画、恢复按钮、展示结果或原因
   */
  function poll() {
    clearPoll();
    pollFails = 0;
    const jobId = state.jobId;
    const tick = async () => {
      if (state.jobId !== jobId) return;
      let j;
      try {
        j = await jget(`/api/jobs/${encodeURIComponent(jobId)}`);
        pollFails = 0;
        TTProgress.setNetWarn('');
      } catch (e) {
        pollFails++;
        if (e.status === 404) return finish({ id: jobId, status: 'error', error: t('jobMissing'), accounts: [], handles: [], events: [] });
        if (pollFails >= 40) {
          TTProgress.setNetWarn('');
          return finish({ ...(state.task || {}), id: jobId, status: 'error', error: t('pollGaveUp', { msg: e.message }), finishedAt: new Date().toISOString() });
        }
        TTProgress.setNetWarn(t('reconnecting', { n: pollFails }));
        pollTimer = setTimeout(tick, Math.min(5000, 1200 + pollFails * 300));
        return;
      }
      if (TTProgress.isRunning(j)) {
        state.task = j;
        TTProgress.render(j);
        updateEmptyProgress(j);
        renderStartBtn();
        pollTimer = setTimeout(tick, 1200);
        return;
      }
      finish(j);
    };
    tick();
  }

  function finish(j) {
    clearPoll();
    state.busy = false;
    state.task = j;
    TTProgress.render(j);
    renderStartBtn();
    const n = (j.rows || []).length;
    if (n) {
      TTResults.load(j);
      if (j.status === 'done') toast(t('allDone', { n }), 'ok');
      else if (j.status === 'stopped') toast(t('stoppedKept', { n }), 'warn');
    } else {
      state.job = null;
      state.rows = [];
      TTResults.render();
      $('#emptyState').hidden = false;
      if (j.status === 'done' || j.status === 'stopped') {
        $('#emptyTitle').textContent = t(j.status === 'stopped' ? 'emptyStopped' : 'emptyNoVideos');
        $('#emptySub').textContent = t('emptyNoVideosSub');
      } else {
        toast(t('taskFailedMsg', { msg: j.error || '' }), 'err');
      }
    }
    loadHistory();
  }

  /** 平台数据（创作中心 / 卖家中心）同步后，重新合并当前任务的明细 */
  async function refreshSync() {
    if (!state.jobId || state.busy) return;
    try {
      const r = await jpost(`/api/jobs/${encodeURIComponent(state.jobId)}/sync`);
        if (r.rows && r.rows.length && state.job) {
        state.job.rows = r.rows;
        TTResults.load(state.job);
      }
    } catch (_) {}
    TTResults.refreshCreator();
  }

  /* ---------------- 导出（按钮内 Loading，失败显示原因） ---------------- */
  async function exportFile(kind, btn) {
    if (!state.jobId) return;
    const done = btnBusy(btn, t('exporting'));
    try {
      const res = await fetch(`${API}/api/jobs/${encodeURIComponent(state.jobId)}/export.${kind}?lang=${window.currentLang}`);
      if (!res.ok) throw new Error((await res.text()).slice(0, 200) || `HTTP ${res.status}`);
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename="([^"]+)"/.exec(cd);
      const name = m ? decodeURIComponent(m[1]) : `tiktok.${kind}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
      toast(t('exported', { name }), 'ok');
    } catch (e) {
      toast(t('exportFailed', { msg: e.message }), 'err');
    } finally {
      done();
    }
  }

  /* ---------------- 历史任务 ---------------- */
  async function loadHistory() {
    const host = $('#history');
    if (!history.length && host) host.innerHTML = `<div class="skeleton-list"><i></i><i></i><i></i></div>`;
    try {
      history = await jget('/api/jobs');
    } catch (e) {
      if (host) host.innerHTML = `<div class="note err">${esc(e.message)}</div>`;
      return;
    }
    renderHistory();
    renderQuickAcc();
  }

  const STATUS_BADGE = { done: 'ok', error: 'err', interrupted: 'err', stopped: '', running: 'run', queued: 'run', stopping: 'run' };
  function renderHistory() {
    const host = $('#history');
    if (!host) return;
    $('#historyCount').textContent = history.length ? String(history.length) : '';
    if (!history.length) {
      host.innerHTML = `<div class="idle">${esc(t('noHistory'))}</div>`;
      return;
    }
    host.innerHTML = history
      .map((j) => {
        const cmp = j.compareFrom ? ` · ${esc(t('cmpMode_' + (j.compareMode || 'custom')))}` : '';
        const status = j.status === 'done' ? fmtInt(j.rowCount || 0) : t('jobStatus_' + j.status);
        return `<div class="hist-item${state.jobId === j.id ? ' cur' : ''}">
          <input type="checkbox" data-pick="${esc(j.id)}" aria-label="select">
          <button type="button" class="hist-main" data-open="${esc(j.id)}">
            <b>${esc(j.handles.map((h) => '@' + h).join(' '))}</b>
            <span>${esc(rangeText(j.currentFrom || j.from, j.currentTo || j.to))}${cmp}${j.source && j.source !== 'app' ? ` · ${esc(j.source)}` : ''}</span>
          </button>
          <span class="badge ${STATUS_BADGE[j.status] || ''}" title="${esc(j.error || '')}">${esc(status)}</span>
          <button type="button" class="icon-btn" data-del="${esc(j.id)}" title="${esc(t('histDeleteOne'))}" aria-label="${esc(t('histDeleteOne'))}">×</button>
        </div>`;
      })
      .join('');
    updateHistMeta();
  }
  function updateHistMeta() {
    const n = $$('#history input[data-pick]:checked').length;
    $('#histDel').disabled = !n;
    $('#histMeta').textContent = n ? t('histPicked', { n }) : '';
  }
  /** 打开历史任务：当前结果先保留，点中的那一行转圈，载入成功再切换（不闪白屏） */
  async function openJob(id, btn) {
    if (state.busy) return toast(t('busyNoSwitch'), 'warn');
    // 历史行：行内转圈 + 右侧结果区变淡并显示顶部加载条，不替换整行文字
    if (btn) btn.classList.add('is-loading');
    const res = $('#results');
    const host = res && !res.hidden ? res : $('#emptyState');
    if (host) host.classList.add('is-loading');
    const done = () => {
      if (btn) btn.classList.remove('is-loading');
      if (host) host.classList.remove('is-loading');
    };
    try {
      const j = await jget(`/api/jobs/${encodeURIComponent(id)}`);
      state.jobId = id;
      TTProgress.reset();
      TTTable.reset();
      if (TTProgress.isRunning(j)) {
        state.busy = true;
        state.task = j;
        renderStartBtn();
        poll();
        return;
      }
      state.task = j;
      TTProgress.render(j);
      if ((j.rows || []).length) TTResults.load(j);
      else {
        state.job = null;
        state.rows = [];
        TTResults.render();
      }
      renderHistory();
    } catch (e) {
      toast(`${t('loadFailed')}：${e.message}`, 'err');
    } finally {
      done();
    }
  }
  async function deleteJobs(ids, btn) {
    const done = btnBusy(btn);
    try {
      if (ids.length === 1) await api('/api/jobs/' + encodeURIComponent(ids[0]), { method: 'DELETE' });
      else await jpost('/api/jobs/delete', { ids });
      toast(t('histDeleted', { n: ids.length }), 'ok');
      await loadHistory();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      done();
    }
  }

  /** 最近抓过的账号（快捷填入） */
  function renderQuickAcc() {
    const host = $('#quickAcc');
    if (!host) return;
    const names = [];
    for (const j of history) {
      for (const h of j.handles || []) {
        if (/^[a-z0-9._]{2,30}$/i.test(h) && !names.includes(h)) names.push(h);
        if (names.length >= 4) break;
      }
      if (names.length >= 4) break;
    }
    host.hidden = !names.length;
    host.innerHTML = names.map((n) => `<button type="button" data-quick="${esc(n)}" title="${esc(t('quickAcc'))}">+ @${esc(n)}</button>`).join('');
  }

  /* ---------------- 窗口控制条（仅 Electron 无边框窗口） ---------------- */
  function initTitlebar() {
    const tb = $('#titlebar');
    const win = window.TTWin;
    if (!tb || !win || typeof win.minimize !== 'function') return;
    tb.hidden = false;
    document.body.classList.add('has-titlebar');
    if (window.TTPlatform === 'darwin') {
      // macOS：红黄绿灯由系统绘制，隐藏自绘的 Windows 风格三枚按钮，只保留顶部拖动区
      document.body.classList.add('is-mac');
      const btns = $('#titlebar .tb-btns');
      if (btns) btns.hidden = true;
      return;
    }
    $('#tbMin').addEventListener('click', () => win.minimize());
    $('#tbMax').addEventListener('click', () => (typeof win.toggleMax === 'function' ? win.toggleMax() : win.maximize()));
    $('#tbClose').addEventListener('click', () => win.close());
  }

  /* ---------------- 登录提示气泡（可关闭 / 不再显示） ---------------- */
  function initTipBubble() {
    const b = $('#tipBubble');
    if (prefs.get('tipLoginNever', false) || sessionStorage.getItem('tt.tipClosed') === '1') return;
    b.hidden = false;
    $('#tipClose').addEventListener('click', () => {
      sessionStorage.setItem('tt.tipClosed', '1');
      b.hidden = true;
    });
    $('#tipNever').addEventListener('click', () => {
      prefs.set('tipLoginNever', true);
      b.hidden = true;
      toast(t('tipNeverDone'), 'ok');
    });
    $('#tipLogin').addEventListener('click', () => {
      b.hidden = true;
      TTSettings.open();
    });
  }

  function init() {
    initModals();
    TTCollapse.init();
    TTFilter.init();
    TTProgress.init();
    TTResults.init();
    TTTable.init();
    TTLogin.init();
    TTSettings.init();
    initTitlebar();
    initTipBubble();

    $$('.lang-switch button').forEach((b) => b.addEventListener('click', () => applyLang(b.dataset.lang)));
    applyLang(window.detectLang());

    // 账号输入框记住上次填的内容
    const ta = $('#handles');
    ta.value = prefs.get('handles', '');
    ta.addEventListener('input', () => prefs.set('handles', ta.value));
    $('#startBtn').addEventListener('click', () => start());
    $('#stopBtn').addEventListener('click', stop);
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') start();
    });
    $('#exportXlsx').addEventListener('click', (e) => exportFile('xlsx', e.currentTarget));
    $('#exportCsv').addEventListener('click', (e) => exportFile('csv', e.currentTarget));

    $('#history').addEventListener('click', (e) => {
      const o = e.target.closest('[data-open]');
      if (o) return openJob(o.dataset.open, o);
      const d = e.target.closest('[data-del]');
      if (d && confirm(t('histConfirmOne'))) deleteJobs([d.dataset.del], d);
    });
    $('#history').addEventListener('change', updateHistMeta);
    $('#histAll').addEventListener('change', (e) => {
      $$('#history input[data-pick]').forEach((c) => (c.checked = e.target.checked));
      updateHistMeta();
    });
    $('#histDel').addEventListener('click', (e) => {
      const ids = $$('#history input[data-pick]:checked').map((c) => c.dataset.pick);
      if (!ids.length) return;
      if (confirm(t('histConfirm', { n: ids.length }))) deleteJobs(ids, e.currentTarget);
    });
    $('#quickAcc').addEventListener('click', (e) => {
      const b = e.target.closest('[data-quick]');
      if (!b) return;
      const ta = $('#handles');
      const cur = ta.value.split(/[\n,，\s]+/).map((x) => x.trim()).filter(Boolean);
      if (!cur.includes(b.dataset.quick)) cur.push(b.dataset.quick);
      ta.value = cur.join('\n');
      prefs.set('handles', ta.value);
    });

    checkHealth();
    loadHistory().then(() => {
      // 应用重开时，如果上次还有任务在跑（服务没退出），接着显示它的进度
      const running = history.find((j) => ['running', 'queued', 'stopping'].includes(j.status));
      if (running) {
        state.jobId = running.id;
        state.busy = true;
        renderStartBtn();
        poll();
      }
    });
  }

  return { init, start, rerun, refreshSync };
})();

document.addEventListener('DOMContentLoaded', TTApp.init);

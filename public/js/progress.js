/* ============================================================
   抓取进度（左栏「进度」面板）

   原则：真实状态比看起来精确的假百分比更重要。
   - 标题只显示后端真实上报的阶段（scraper 执行到哪一步才报哪一步）；
   - 进度条按账号分段：完成 / 失败 / 已停止是确定的，正在抓的那段用不确定动画；
   - 结束后（完成 / 停止 / 失败 / 中断）收成一行结果，账号明细与日志折叠在下面。
   ============================================================ */
const TTProgress = (() => {
  let clockSkew = 0;
  let ticker = 0;
  let lastJob = null;
  let netWarn = '';
  const seenLog = new Set();
  const logLines = [];

  const STEPS = ['init', 'launch', 'open', 'profile', 'scroll', 'filter', 'save', 'stats'];
  const RUNNING = ['queued', 'running', 'stopping'];
  const stageText = (s) => t('stage_' + (s || 'init'));

  function elapsedOf(job) {
    if (!job) return 0;
    const start = Date.parse(job.startedAt || job.createdAt);
    if (!Number.isFinite(start)) return 0;
    const end = job.finishedAt && !RUNNING.includes(job.status) ? Date.parse(job.finishedAt) : Date.now() + clockSkew;
    return (end - start) / 1000;
  }
  function tick() {
    const el = $('#taskPanel [data-elapsed]');
    if (el) el.textContent = lastJob && (RUNNING.includes(lastJob.status) || lastJob.finishedAt) ? fmtDuration(elapsedOf(lastJob)) : '';
  }

  /* 日志：事件翻成人话，去重后追加 */
  function collectLog(job) {
    for (const e of job.events || []) {
      let txt = null;
      let err = false;
      if (e.type === 'account-start') txt = e.attempt > 1 ? t('logStartRetry', { h: e.handle, n: e.attempt }) : t('logStart', { h: e.handle });
      else if (e.type === 'account-retry') txt = t('logRetry', { h: e.handle, reason: e.reason || '' });
      else if (e.type === 'account-error') { txt = t('logError', { h: e.handle, msg: e.error || '' }); err = true; }
      else if (e.type === 'account-done') { txt = e.error ? t('logError', { h: e.handle, msg: e.error }) : t('logDone', { h: e.handle, n: e.count }); err = !!e.error; }
      else if (e.type === 'account-stopped') txt = t('logStopped', { h: e.handle });
      else if (e.type === 'stage') txt = (e.handle ? '@' + e.handle + ' · ' : '') + stageText(e.stage);
      if (!txt) continue;
      const key = e.t + '|' + e.type + '|' + (e.handle || '') + '|' + (e.stage || '');
      if (seenLog.has(key)) continue;
      seenLog.add(key);
      logLines.push({ time: new Date(e.t + 7 * 3600 * 1000).toISOString().slice(11, 19), txt, err });
    }
    if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  }
  const logHtml = () =>
    `<div class="log" role="log">${
      logLines.length ? logLines.map((l) => `<div class="${l.err ? 'e' : ''}"><time>${esc(l.time)}</time>${esc(l.txt)}</div>`).join('') : esc(t('logEmpty'))
    }</div>`;

  /* 账号行（旧版 acct-block 样式） */
  const BADGE = { done: 'ok', failed: 'err', running: 'run', retrying: 'warn', stopped: '', queued: '' };
  function accountRows(job) {
    return (job.accounts || [])
      .map((a) => {
        const live = a.state === 'running' || a.state === 'retrying';
        const label = a.state === 'retrying' ? t('acc_retrying', { n: a.attempt || 2, max: 3 }) : t('acc_' + a.state);
        const n = live ? `${live ? '<span class="spin"></span> ' : ''}${esc(stageText(a.stage || 'open'))} · ${esc(fmtInt(a.found || 0))}` : a.state === 'done' ? esc(t('acc_doneN', { n: fmtInt(a.count || 0) })) : '';
        return `<div class="acct-block"><div class="hd">
            <span class="h">@${esc(a.handle)}</span>
            <span class="n">${n}</span>
            <span class="badge ${BADGE[a.state] || ''}">${esc(label)}</span>
          </div>
          ${a.error && (a.state === 'failed' || a.state === 'retrying') ? `<div class="e">${esc(a.error)}</div>` : ''}
          ${a.state === 'done' && a.complete === false ? `<div class="e warn">${esc(t('accIncomplete'))}</div>` : ''}
        </div>`;
      })
      .join('');
  }

  function render(job) {
    const body = $('#taskBody');
    if (!body) return;
    if (!job) {
      body.innerHTML = `<div class="idle">${esc(t('notStarted'))}</div>`;
      lastJob = null;
      tick();
      return;
    }
    lastJob = job;
    if (job.now) clockSkew = Date.parse(job.now) - Date.now();
    collectLog(job);
    const acc = job.accounts || [];
    const total = acc.length || (job.handles || []).length;
    const settled = acc.filter((a) => ['done', 'failed', 'stopped'].includes(a.state)).length;
    const found = acc.reduce((s, a) => s + (a.state === 'done' ? a.count || 0 : a.found || 0), 0);

    if (RUNNING.includes(job.status)) {
      const cur = acc.find((a) => a.state === 'running' || a.state === 'retrying');
      const stage = job.status === 'stopping' ? 'stopping' : (cur && cur.stage) || job.stage;
      const at = STEPS.indexOf(stage);
      body.innerHTML = `
        <div class="task-head"><span class="spin"></span><div class="task-title">${esc(stageText(stage))}${cur ? ` · @${esc(cur.handle)}` : ''}</div></div>
        ${netWarn ? `<div class="notice warn" style="margin-bottom:12px"><span>${esc(netWarn)}</span></div>` : ''}
        <div class="segbar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${settled}">${acc.map((a) => `<i class="s-${a.state}" title="@${esc(a.handle)}"></i>`).join('')}</div>
        <div class="task-meta"><span>${esc(t('tsAccounts'))} <b>${settled}/${total}</b></span><span>${esc(t('tsFound'))} <b>${fmtInt(found)}</b></span></div>
        <ol class="steps" aria-hidden="true">${STEPS.map((s, i) => `<li class="${at < 0 ? '' : i < at ? 'done' : i === at ? 'on' : ''}" title="${esc(t('step_' + s))}"></li>`).join('')}</ol>
        ${accountRows(job)}
        <div style="margin-top:12px">${TTCollapse.html({ id: 'task:log', variant: 'item', title: esc(t('log')), summary: `<span>${logLines.length}</span>`, extra: `<button type="button" class="xs ghost" data-copy-log>${esc(t('copyLog'))}</button>`, body: logHtml() })}</div>`;
      if (!ticker) ticker = setInterval(tick, 1000);
    } else {
      const failedN = acc.filter((a) => a.state === 'failed').length;
      const doneN = acc.filter((a) => a.state === 'done').length;
      const kind = job.status === 'done' ? (failedN ? 'warn' : 'ok') : job.status === 'stopped' ? '' : 'err';
      const title =
        job.status === 'done' ? (failedN ? t('taskDonePartial', { ok: doneN, bad: failedN }) : t('taskDone'))
        : job.status === 'stopped' ? t('taskStopped', { ok: doneN, total })
        : job.status === 'interrupted' ? t('taskInterrupted') : t('taskFailed');
      body.innerHTML = `
        <div class="task-done">
          <span class="dot-st ${kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : ''}"></span>
          <div class="grow"><b>${esc(title)}</b><span>${esc(t('foundN', { n: fmtInt(job.rows ? job.rows.length : found) }))}</span>
            ${job.error && kind === 'err' ? `<span class="ts-err">${esc(job.error)}</span>` : ''}</div>
          ${job.status !== 'done' || failedN ? `<button type="button" class="xs" data-task-retry>${esc(t('retryTask'))}</button>` : ''}
        </div>
        ${acc.length || logLines.length ? `<div style="margin-top:12px">${TTCollapse.html({ id: 'task:detail', variant: 'item', title: esc(t('taskDetail')), body: accountRows(job) + `<div style="margin-top:8px">${logHtml()}</div>` })}</div>` : ''}`;
      if (ticker) clearInterval(ticker);
      ticker = 0;
    }
    tick();
    const log = body.querySelector('.log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  function reset() {
    seenLog.clear();
    logLines.length = 0;
    netWarn = '';
    lastJob = null;
    if (ticker) clearInterval(ticker);
    ticker = 0;
  }
  function setNetWarn(msg) {
    netWarn = msg || '';
    if (lastJob) render(lastJob);
  }

  function init() {
    $('#taskPanel').addEventListener('click', (e) => {
      if (e.target.closest('[data-copy-log]')) {
        navigator.clipboard.writeText(logLines.map((l) => `${l.time} ${l.txt}`).join('\n')).then(() => toast(t('copied'), 'ok'), () => {});
      } else if (e.target.closest('[data-task-retry]') && lastJob) {
        TTApp.rerun(lastJob);
      }
    });
  }

  return { init, render, reset, setNetWarn, isRunning: (job) => !!job && RUNNING.includes(job.status) };
})();

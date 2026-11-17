/* ============================================================
   抓取任务进度面板

   原则：真实状态比看起来精确的假百分比更重要。
   - 阶段文字全部来自后端真实上报的 stage（scraper 执行到哪一步才报哪一步）；
   - 总进度条按「账号」分段：已完成 / 失败 / 已停止的账号是确定的，
     正在抓的账号不知道还剩多少视频，所以那一段用不确定动画，并显示「已发现 N 条」；
   - 结束后（完成 / 停止 / 失败 / 中断）收起成一行摘要，可展开看每个账号与日志。
   ============================================================ */
const TTProgress = (() => {
  let clockSkew = 0; // 服务端时间 - 本机时间
  let ticker = 0;
  let lastJob = null;
  let netWarn = '';
  const seenLog = new Set();
  const logLines = [];

  const ACCOUNT_STEPS = ['open', 'profile', 'scroll', 'filter'];
  const JOB_STEPS = ['init', 'launch', ...ACCOUNT_STEPS, 'save', 'stats', 'done'];
  const RUNNING = ['queued', 'running', 'stopping'];

  const stageText = (s) => (s ? t('stage_' + s) : t('stage_init'));

  function elapsedOf(job) {
    if (!job) return 0;
    const start = Date.parse(job.startedAt || job.createdAt);
    if (!Number.isFinite(start)) return 0;
    const end = job.finishedAt && !RUNNING.includes(job.status) ? Date.parse(job.finishedAt) : Date.now() + clockSkew;
    return (end - start) / 1000;
  }

  function tick() {
    $$('[data-elapsed]').forEach((el) => (el.textContent = fmtDuration(elapsedOf(lastJob))));
  }

  /* ---------------- 日志：把事件翻成人话，去重后追加 ---------------- */
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
      const time = new Date(e.t + 7 * 3600 * 1000).toISOString().slice(11, 19);
      logLines.push({ time, txt, err });
    }
    if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  }
  function logHtml() {
    if (!logLines.length) return `<div class="log-empty">${esc(t('logEmpty'))}</div>`;
    return logLines.map((l) => `<div class="${l.err ? 'e' : ''}"><time>${esc(l.time)}</time>${esc(l.txt)}</div>`).join('');
  }

  /* ---------------- 账号 ---------------- */
  function accountState(a) {
    const map = {
      queued: ['queued', t('acc_queued')],
      running: ['running', t('acc_running')],
      retrying: ['retrying', t('acc_retrying', { n: a.attempt || 2, max: 3 })],
      done: ['done', t('acc_done')],
      failed: ['failed', t('acc_failed')],
      stopped: ['stopped', t('acc_stopped')],
    };
    return map[a.state] || ['queued', a.state || ''];
  }

  function accountRows(job) {
    return (job.accounts || [])
      .map((a) => {
        const [cls, label] = accountState(a);
        const live = a.state === 'running' || a.state === 'retrying';
        const stage = live ? stageText(a.stage || 'open') : a.state === 'done' ? t('acc_doneN', { n: a.count || 0 }) : '';
        const found = live || a.state === 'done' ? t('foundN', { n: fmtInt(a.state === 'done' ? a.count : a.found || 0) }) : '';
        return `<div class="acc-row s-${cls}">
          <span class="acc-dot" aria-hidden="true">${live ? '<span class="spinner xs"></span>' : ''}</span>
          <span class="acc-h">@${esc(a.handle)}</span>
          <span class="pill s-${cls}">${esc(label)}</span>
          <span class="acc-stage">${esc(stage)}</span>
          <span class="acc-found">${esc(found)}</span>
          ${a.error && (a.state === 'failed' || a.state === 'retrying') ? `<div class="acc-err">${esc(a.error)}</div>` : ''}
          ${a.state === 'done' && a.complete === false ? `<div class="acc-err warn">${esc(t('accIncomplete'))}</div>` : ''}
        </div>`;
      })
      .join('');
  }

  /** 按账号分段的总进度条：确定的部分画满，正在跑的那段用不确定动画 */
  function segBar(job) {
    const acc = job.accounts || [];
    if (!acc.length) return `<div class="segbar indet"><i class="seg s-running"></i></div>`;
    return `<div class="segbar" role="progressbar" aria-valuemin="0" aria-valuemax="${acc.length}" aria-valuenow="${
      acc.filter((a) => ['done', 'failed', 'stopped'].includes(a.state)).length
    }" aria-valuetext="${esc(t('accProgress', { done: acc.filter((a) => ['done', 'failed', 'stopped'].includes(a.state)).length, total: acc.length }))}">${acc
      .map((a) => `<i class="seg s-${a.state === 'retrying' ? 'running' : a.state}" title="@${esc(a.handle)}"></i>`)
      .join('')}</div>`;
  }

  /** 阶段步骤条：当前账号走到哪一步（含任务级的启动 / 保存 / 统计） */
  function steps(job) {
    const cur = job.status === 'stopping' ? 'stopping' : job.stage || 'init';
    const at = JOB_STEPS.indexOf(cur);
    return `<ol class="steps">${JOB_STEPS.filter((s) => s !== 'done')
      .map((s, i) => {
        const st = at < 0 ? '' : i < at ? 'done' : i === at ? 'on' : '';
        return `<li class="${st}">${esc(t('step_' + s))}</li>`;
      })
      .join('')}</ol>`;
  }

  /* ---------------- 渲染 ---------------- */
  function render(job) {
    const host = $('#taskPanel');
    if (!host) return;
    if (!job) {
      host.hidden = true;
      return;
    }
    lastJob = job;
    if (job.now) clockSkew = Date.parse(job.now) - Date.now();
    collectLog(job);
    host.hidden = false;

    const acc = job.accounts || [];
    const total = acc.length || (job.handles || []).length;
    const finishedN = acc.filter((a) => ['done', 'failed', 'stopped'].includes(a.state)).length;
    const found = acc.reduce((s, a) => s + (a.state === 'done' ? a.count || 0 : a.found || 0), 0);
    const running = RUNNING.includes(job.status);

    if (running) {
      const curAcc = acc.find((a) => a.state === 'running' || a.state === 'retrying');
      const title =
        job.status === 'stopping'
          ? t('stage_stopping')
          : curAcc
          ? `${stageText(curAcc.stage || job.stage)} · @${curAcc.handle}`
          : stageText(job.stage);
      host.className = 'task card running';
      host.innerHTML = `
        <div class="task-head">
          <span class="spinner" aria-hidden="true"></span>
          <div class="task-title" aria-live="polite">${esc(title)}</div>
          <div class="task-time"><span>${esc(t('elapsed'))}</span> <b data-elapsed>${fmtDuration(elapsedOf(job))}</b></div>
        </div>
        ${netWarn ? `<div class="task-warn">${esc(netWarn)}</div>` : ''}
        <div class="task-stats">
          <div><span>${esc(t('tsAccounts'))}</span><b>${finishedN} / ${total}</b></div>
          <div><span>${esc(t('tsCurrent'))}</span><b>${curAcc ? '@' + esc(curAcc.handle) : DASH}</b></div>
          <div><span>${esc(t('tsFound'))}</span><b>${fmtInt(found)}</b></div>
          <div><span>${esc(t('tsRange'))}</span><b>${esc(rangeText(job.from, job.to))}</b></div>
        </div>
        ${segBar(job)}
        ${steps(job)}
        <div class="acc-list">${accountRows(job)}</div>
        ${TTCollapse.html({ id: 'task:log', variant: 'item', title: esc(t('log')), meta: esc(t('logMeta', { n: logLines.length })), body: `<div class="log" role="log">${logHtml()}</div>`, extra: `<button type="button" class="btn xs ghost" data-copy-log>${esc(t('copyLog'))}</button>` })}`;
    } else {
      const kind = job.status === 'done' ? 'done' : job.status === 'stopped' ? 'stopped' : 'failed';
      const failedN = acc.filter((a) => a.state === 'failed').length;
      const doneN = acc.filter((a) => a.state === 'done').length;
      let title;
      if (kind === 'done') title = failedN ? t('taskDonePartial', { ok: doneN, bad: failedN }) : t('taskDone');
      else if (kind === 'stopped') title = t('taskStopped', { ok: doneN, total });
      else title = job.status === 'interrupted' ? t('taskInterrupted') : t('taskFailed');
      const detail = [t('tsAccountsN', { n: total }), t('foundN', { n: fmtInt(job.rows ? job.rows.length : found) }), t('elapsedT', { t: fmtDuration(elapsedOf(job)) })];
      host.className = `task card finished k-${kind}`;
      host.innerHTML = `
        <div class="task-sum">
          <span class="ts-icon" aria-hidden="true"></span>
          <div class="ts-text"><b>${esc(title)}</b><span>${esc(detail.join(' · '))}</span>
            ${job.error && kind === 'failed' ? `<span class="ts-err">${esc(job.error)}</span>` : ''}</div>
          <div class="ts-actions">
            ${kind !== 'done' || failedN ? `<button type="button" class="btn sm" data-task-retry>${esc(t('retryTask'))}</button>` : ''}
            <button type="button" class="icon-btn" data-task-dismiss aria-label="${esc(t('close'))}" title="${esc(t('close'))}">×</button>
          </div>
        </div>
        ${TTCollapse.html({
          id: 'task:detail',
          variant: 'item',
          title: esc(t('taskDetail')),
          body: `<div class="acc-list">${accountRows(job)}</div><div class="log" role="log">${logHtml()}</div>`,
        })}`;
    }
    const log = host.querySelector('.log');
    if (log) log.scrollTop = log.scrollHeight;
    if (running && !ticker) ticker = setInterval(tick, 1000);
    if (!running && ticker) {
      clearInterval(ticker);
      ticker = 0;
    }
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
    const host = $('#taskPanel');
    host.addEventListener('click', (e) => {
      if (e.target.closest('[data-copy-log]')) {
        const txt = logLines.map((l) => `${l.time} ${l.txt}`).join('\n');
        navigator.clipboard.writeText(txt).then(() => toast(t('copied'), 'ok'), () => {});
      } else if (e.target.closest('[data-task-dismiss]')) {
        host.hidden = true;
      } else if (e.target.closest('[data-task-retry]')) {
        if (lastJob) TTApp.rerun(lastJob);
      }
    });
  }

  return { init, render, reset, setNetWarn, isRunning: (job) => !!job && RUNNING.includes(job.status) };
})();

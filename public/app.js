/* TikTok 多账号抓取 · 前端逻辑（中/泰/英三语） */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* 界面既可由本地 http 提供（浏览器/开发），也可由 Electron 以 file:// 加载。
   后者需要一个绝对 API 基址，通过 ?api=http://127.0.0.1:PORT 传入；前者留空走相对路径。 */
const API = (new URLSearchParams(location.search).get('api') || '').replace(/\/$/, '');

const state = {
  jobId: null,
  timer: null,
  rows: [],
  summary: [],
  tab: '__all__',
  search: '',
  sortKey: 'views',
  sortDir: 'desc',
  poll: 0,
  busy: false,
};

const fmt = (n) => (n === null || n === undefined || n === '' ? '-' : Number(n).toLocaleString('en-US'));
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function bangkokToday() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ---------------- 语言 ---------------- */
function applyLang(lang) {
  window.currentLang = lang;
  localStorage.setItem('lang', lang);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  $$('.lang-switch button').forEach((b) => {
    const on = b.dataset.lang === lang;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  $$('[data-i18n]').forEach((el) => {
    const val = t(el.dataset.i18n);
    if (el.dataset.i18nHtml === '1') el.innerHTML = val;
    else el.textContent = val;
  });
  $$('[data-i18n-ph]').forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  document.title = t('title');

  renderProgress(lastJob);
  renderResults();
  renderHistory(lastHistory);
  renderBrowserChip(lastHealth);
}

/* ---------------- Toast ---------------- */
function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------------- 浏览器状态 ---------------- */
let lastHealth = null;
async function checkHealth() {
  try {
    lastHealth = await fetch(API + '/api/health').then((x) => x.json());
  } catch (e) {
    lastHealth = { chromeFound: false, error: true };
  }
  renderBrowserChip(lastHealth);
}

function renderBrowserChip(h) {
  const el = $('#browserChip');
  if (!el || !h) return;
  if (h.chromeFound) {
    const name = (h.chrome || '').split(/[\\/]/).pop() || 'chromium';
    el.className = 'browser-chip ok';
    el.innerHTML = `<span class="dot"></span><span>${esc(t('browserReady', { name }))}</span>`;
  } else {
    el.className = 'browser-chip bad';
    el.innerHTML = `<span class="dot"></span><span>${esc(t('noBrowser').replace(/<[^>]+>/g, ''))}</span>`;
  }
}

/* ---------------- 启动 ---------------- */
function init() {
  const today = bangkokToday();
  $('#to').value = today;
  $('#from').value = today.slice(0, 8) + '01';

  $$('.lang-switch button').forEach((b) => b.addEventListener('click', () => applyLang(b.dataset.lang)));
  applyLang(window.detectLang());

  $('#startBtn').addEventListener('click', start);
  $('#stopBtn').addEventListener('click', stopPolling);
  $('#exportXlsx').addEventListener('click', () => download('xlsx'));
  $('#exportCsv').addEventListener('click', () => download('csv'));
  $('#copyLog').addEventListener('click', () => {
    navigator.clipboard.writeText($('#log').innerText);
    $('#copyLog').textContent = t('copied');
    setTimeout(() => ($('#copyLog').textContent = t('copyLog')), 1200);
  });
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderResults();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') start();
  });

  $$('[data-range]').forEach((b) =>
    b.addEventListener('click', () => {
      const t0 = bangkokToday();
      const y = Number(t0.slice(0, 4));
      const m = Number(t0.slice(5, 7));
      const set = (f, to) => {
        $('#from').value = f;
        $('#to').value = to;
      };
      const r = b.dataset.range;
      const pad = (n) => String(n).padStart(2, '0');
      if (r === 'thisMonth') set(t0.slice(0, 8) + '01', t0);
      else if (r === 'lastMonth') {
        const pm = m === 1 ? 12 : m - 1;
        const py = m === 1 ? y - 1 : y;
        const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
        set(`${py}-${pad(pm)}-01`, `${py}-${pad(pm)}-${pad(last)}`);
      } else if (r === 'last3') {
        let pm = m - 2;
        let py = y;
        if (pm <= 0) {
          pm += 12;
          py -= 1;
        }
        set(`${py}-${pad(pm)}-01`, t0);
      } else if (r === 'all') set('2020-01-01', t0);
    })
  );

  checkHealth();
  loadHistory();
}

function setBusy(b) {
  state.busy = b;
  $('#startBtn').disabled = b;
  $('#startBtn').textContent = b ? t('starting') : t('start');
  $('#stopBtn').disabled = !b;
  updateExportState();
}

function updateExportState() {
  const dis = !!state.busy || !state.rows.length;
  $('#exportXlsx').disabled = dis;
  $('#exportCsv').disabled = dis;
}

/* 加载骨架：任务进行中、结果未就绪时占位，避免“白屏” */
function showSkeleton() {
  $('#emptyPanel').style.display = 'none';
  $('#resultsPanel').style.display = 'block';
  $('#resultMeta').textContent = '';
  $('#tableMeta').textContent = '';
  $('#tabs').innerHTML = '';
  $('#cards').innerHTML = Array.from({ length: 3 })
    .map(
      () =>
        `<div class="card"><div class="skel skel-line" style="width:55%"></div>` +
        `<div class="skel" style="height:24px;width:42%;margin:10px 0"></div>` +
        `<div class="skel skel-line" style="width:85%"></div>` +
        `<div class="skel skel-line" style="width:68%"></div></div>`
    )
    .join('');
  $('#rows').innerHTML = Array.from({ length: 8 })
    .map(() => `<tr class="skel-row">${'<td><div class="skel skel-line" style="margin:0"></div></td>'.repeat(13)}</tr>`)
    .join('');
}

/* ---------------- 提交任务 ---------------- */
async function start() {
  const handles = $('#handles').value;
  if (!handles.trim()) return toast(t('needUsername'), 'err');
  $('#log').innerHTML = '';
  seenEvents = new Set();
  state.rows = [];
  state.summary = [];
  setBusy(true);
  showSkeleton();

  try {
    const res = await fetch(API + '/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handles,
        from: $('#from').value,
        to: $('#to').value,
        concurrency: Number($('#conc').value),
      }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'submit failed');
    state.jobId = j.id;
    logLine(t('submitted', { id: j.id, n: j.handles.length, from: j.from, to: j.to }));
    poll();
  } catch (e) {
    logLine(t('submitFailed', { msg: e.message }), true);
    toast(t('submitFailed', { msg: e.message }), 'err');
    setBusy(false);
  }
}

function logLine(text, isErr) {
  const el = $('#log');
  const div = document.createElement('div');
  if (isErr) div.className = 'e';
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  setBusy(false);
}

function poll() {
  if (state.timer) clearInterval(state.timer);
  state.poll = 0;
  const tick = async () => {
    state.poll++;
    try {
      const j = await fetch(`${API}/api/jobs/${state.jobId}`).then((x) => x.json());
      renderProgress(j);
      if (j.status === 'done' || j.status === 'error') {
        stopPolling();
        if (j.status === 'error') {
          logLine(t('taskFailed', { msg: j.error }), true);
          toast(t('taskFailed', { msg: j.error }), 'err');
          $('#resultsPanel').style.display = 'none';
          $('#emptyPanel').style.display = 'block';
          updateExportState();
        } else {
          state.rows = j.rows || [];
          state.summary = j.summary || [];
          state.tab = '__all__';
          renderResults();
          logLine(t('allDone', { n: state.rows.length }));
          toast(t('allDone', { n: state.rows.length }), 'ok');
          loadHistory();
        }
      }
    } catch (e) {
      if (state.poll > 20) stopPolling();
    }
  };
  tick();
  state.timer = setInterval(tick, 1500);
}

/* ---------------- 进度 ---------------- */
let lastJob = null;
let seenEvents = new Set();

function renderProgress(j) {
  if (!j) return;
  lastJob = j;
  $('#resultMeta').textContent = `${j.from} ~ ${j.to}`;
  $('#emptyPanel').style.display = 'none';

  const total = j.handles.length;
  const doneCount = (j.accounts || []).filter((a) => a.state === 'done' || a.state === 'failed').length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;

  $('#accounts').innerHTML =
    `<div class="pbar" style="margin:0 0 10px"><i style="width:${pct}%"></i></div>` +
    ((j.accounts || [])
      .map((a) => {
        const cls = a.state === 'done' ? 'ok' : a.state === 'failed' ? 'err' : 'run';
        const stKey = 'state' + a.state.charAt(0).toUpperCase() + a.state.slice(1);
        let label;
        if (a.state === 'done') label = t('doneN', { n: a.count });
        else if (a.state === 'failed') label = t('failed');
        else if (a.state === 'retrying') label = t('retrying', { n: a.attempt || 2 });
        else label = `<span class="spin"></span> ${t('running')} ${a.found || 0}`;
        return `<div class="acct-block"><div class="hd">
          <span class="h">@${esc(a.handle)}</span>
          <span class="n">${label}</span>
          <span class="badge ${cls}">${esc(t(stKey))}</span>
        </div></div>`;
      })
      .join('') || `<div class="empty" style="padding:20px">${esc(t('notStarted'))}</div>`);

  (j.events || []).forEach((e) => {
    let txt = null;
    if (e.type === 'account-start') txt = e.attempt > 1 ? t('startAccRetry', { h: e.handle, n: e.attempt }) : t('startAcc', { h: e.handle });
    else if (e.type === 'account-retry') txt = t('retryAcc', { h: e.handle, reason: e.reason || '' });
    else if (e.type === 'account-error') txt = t('errAcc', { h: e.handle, msg: e.error || '' });
    else if (e.type === 'account-done') txt = t('doneAcc', { h: e.handle, n: e.count });
    else if (e.type === 'account-progress' && e.found && e.found % 48 === 0) txt = t('foundAcc', { h: e.handle, n: e.found });
    const key = txt + '|' + e.t;
    if (txt && !seenEvents.has(key)) {
      seenEvents.add(key);
      logLine(txt);
    }
  });
}

/* ---------------- 结果 ---------------- */
function sortRows(rows) {
  const k = state.sortKey;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = a[k];
    const vb = b[k];
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}

function renderResults() {
  if (!state.rows.length) {
    if (!state.busy) $('#resultsPanel').style.display = 'none';
    updateExportState();
    return;
  }
  $('#resultsPanel').style.display = 'block';

  const accounts = [...new Set(state.rows.map((r) => r.account))];
  $('#tabs').innerHTML =
    `<button data-tab="__all__" class="${state.tab === '__all__' ? 'on' : ''}">${esc(t('all'))} (${state.rows.length})</button>` +
    accounts
      .map((a) => {
        const n = state.rows.filter((r) => r.account === a).length;
        return `<button data-tab="${esc(a)}" class="${state.tab === a ? 'on' : ''}">@${esc(a)} (${n})</button>`;
      })
      .join('');
  $$('#tabs [data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      renderResults();
    })
  );

  $('#cards').innerHTML = state.summary
    .map(
      (a) => `<div class="card">
      <div class="k">@${esc(a.handle)}${a.nickname ? ' · ' + esc(a.nickname) : ''}</div>
      <div class="v">${fmt(a.n)} <span style="font-size:12px;font-weight:400;color:#7f7f7f">${esc(t('items'))}</span></div>
      <div class="m">${esc(t('views'))} ${fmt(a.tv)} · ${esc(t('avgViews'))} ${fmt(a.avg)}<br>
      ${esc(t('maxViews'))} ${fmt(a.max)} · ${esc(t('saves'))} ${fmt(a.saves)}<br>
      ${esc(t('colEngage'))} ${(a.inter * 100).toFixed(2)}%${a.stats && a.stats.followerCount ? ' · ' + esc(t('followers')) + ' ' + fmt(a.stats.followerCount) : ''}</div>
    </div>`
    )
    .join('');

  $$('thead th[data-sort]').forEach((th) => {
    const on = th.dataset.sort === state.sortKey;
    th.classList.toggle('on', on);
    const ar = th.querySelector('.ar');
    if (ar) ar.textContent = on ? (state.sortDir === 'desc' ? '▼' : '▲') : '';
    th.onclick = () => {
      if (state.sortKey === th.dataset.sort) state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
      else {
        state.sortKey = th.dataset.sort;
        state.sortDir = th.dataset.sort === 'date' || th.dataset.sort === 'account' ? 'asc' : 'desc';
      }
      renderResults();
    };
  });

  let rows = state.rows.filter((r) => state.tab === '__all__' || r.account === state.tab);
  if (state.search) {
    rows = rows.filter(
      (r) =>
        (r.desc || '').toLowerCase().includes(state.search) ||
        (r.account || '').toLowerCase().includes(state.search) ||
        (r.tags || '').toLowerCase().includes(state.search)
    );
  }
  rows = sortRows(rows);

  $('#rows').innerHTML = rows
    .map(
      (r, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td class="mono">@${esc(r.account)}</td>
      <td class="mono">${esc(r.date)}</td>
      <td class="mono">${esc(r.time)}</td>
      <td class="desc"><div class="d">${esc(r.desc) || `<span style="color:var(--ink-3)">${esc(t('noCaption'))}</span>`}</div></td>
      <td class="num">${fmt(r.views)}</td>
      <td class="num">${fmt(r.likes)}</td>
      <td class="num">${fmt(r.comments)}</td>
      <td class="num">${fmt(r.shares)}</td>
      <td class="num">${fmt(r.saves)}</td>
      <td class="num">${(r.inter * 100).toFixed(2)}%</td>
      <td class="num">${r.duration}s</td>
      <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(t('colOpen'))}</a></td>
    </tr>`
    )
    .join('');

  $('#tableMeta').textContent = `${rows.length} ${t('items')} · ${t('byViews')}`;
  updateExportState();
}

function download(kind) {
  if (!state.jobId) return;
  window.location.href = `${API}/api/jobs/${state.jobId}/export.${kind}?lang=${window.currentLang}`;
}

/* ---------------- 历史 ---------------- */
let lastHistory = [];
async function loadHistory() {
  try {
    lastHistory = await fetch(API + '/api/jobs').then((x) => x.json());
    renderHistory(lastHistory);
  } catch (e) {}
}

function renderHistory(list) {
  const el = $('#history');
  if (!el) return;
  el.innerHTML =
    (list || [])
      .map(
        (j) => `<div class="hist-item">
      <span class="id">${esc(j.id.slice(-6))}</span>
      <span class="hs">${esc(j.handles.map((h) => '@' + h).join(' '))} <span style="color:#a8a8a8">${esc(j.from)}~${esc(j.to)}</span></span>
      <span class="badge ${j.status === 'done' ? 'ok' : j.status === 'error' ? 'err' : ''}">${j.rowCount || 0}</span>
      <button class="lk" data-open="${esc(j.id)}">${esc(t('view'))}</button>
    </div>`
      )
      .join('') || `<div class="empty">${esc(t('noHistory'))}</div>`;
  $$('#history [data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      state.jobId = b.dataset.open;
      $('#resultsPanel').style.display = 'none';
      $('#emptyPanel').style.display = 'none';
      $('#log').innerHTML = '';
      seenEvents = new Set();
      logLine(t('loadingHistory', { id: b.dataset.open }));
      poll();
    })
  );
}

document.addEventListener('DOMContentLoaded', init);

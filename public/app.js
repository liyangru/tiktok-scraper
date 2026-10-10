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
      } else if (r === 'lastWeek') {
        // 上周（自然周：上周一 ~ 上周日）
        const now = new Date(t0 + 'T00:00:00Z');
        const dow = now.getUTCDay() === 0 ? 7 : now.getUTCDay(); // 周一=1 … 周日=7
        const thisMon = new Date(now.getTime() - (dow - 1) * 86400000);
        const lastMon = new Date(thisMon.getTime() - 7 * 86400000);
        const lastSun = new Date(thisMon.getTime() - 86400000);
        set(lastMon.toISOString().slice(0, 10), lastSun.toISOString().slice(0, 10));
      } else if (r === 'last90') {
        set(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10), t0);
      } else if (/^q[1-4]$/.test(r)) {
        const q = Number(r[1]);
        const sm = (q - 1) * 3 + 1;
        const em = sm + 2;
        const lastDay = new Date(Date.UTC(y, em, 0)).getUTCDate();
        set(`${y}-${pad(sm)}-01`, `${y}-${pad(em)}-${pad(lastDay)}`);
      } else if (r === 'all') set('2020-01-01', t0);
    })
  );

  initCompare();
  checkHealth();
  loadHistory();
}

/* ================= 对比日期（小窗，默认同期天数） ================= */
const cmp = { from: '', to: '' };

function daysBetween(a, b) {
  if (!a || !b) return 0;
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000) + 1;
}

function suggestCompare() {
  // 默认：与本期**同一天数**、紧邻本期之前
  const f = $('#from').value;
  const to = $('#to').value;
  if (!f || !to) return null;
  const n = daysBetween(f, to);
  const end = new Date(new Date(f + 'T00:00:00Z').getTime() - 86400000);
  const start = new Date(end.getTime() - (n - 1) * 86400000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10), days: n };
}

function initCompare() {
  const m = $('#cmpModal');
  if (!m) return;
  const close = () => { m.style.display = 'none'; };
  $('#cmpClose').addEventListener('click', close);
  m.addEventListener('click', (e) => { if (e.target === m) close(); });
  $('#cmpBtn').addEventListener('click', () => {
    const s = suggestCompare();
    if (s && !$('#cmpFrom').value) { $('#cmpFrom').value = s.from; $('#cmpTo').value = s.to; }
    $('#cmpStatus').textContent = s ? t('cmpSuggest', { n: s.days }) : '';
    m.style.display = 'flex';
  });
  $('#cmpOk').addEventListener('click', () => {
    cmp.from = $('#cmpFrom').value;
    cmp.to = $('#cmpTo').value;
    if (!cmp.from || !cmp.to) { $('#cmpStatus').textContent = t('cmpNeedBoth'); return; }
    $('#cmpBtn').textContent = `${t('cmpBtn')} ${cmp.from.slice(5)}~${cmp.to.slice(5)}`;
    close();
    toast(t('cmpSet', { from: cmp.from, to: cmp.to }), 'ok');
  });
  $('#cmpClear').addEventListener('click', () => {
    cmp.from = cmp.to = '';
    $('#cmpFrom').value = $('#cmpTo').value = '';
    $('#cmpBtn').textContent = t('cmpBtn');
    close();
  });
}

/* ================= 历史任务：全选 / 批量清除 / 悬浮 × ================= */
function initHistoryActions() {
  const all = $('#histAll');
  if (!all) return;
  all.addEventListener('change', () => {
    $$('#history input[data-pick]').forEach((c) => { c.checked = all.checked; });
    updateHistMeta();
  });
  $('#histDel').addEventListener('click', async () => {
    const ids = $$('#history input[data-pick]').filter((c) => c.checked).map((c) => c.dataset.pick);
    if (!ids.length) return toast(t('histNonePicked'), 'err');
    if (!confirm(t('histConfirm', { n: ids.length }))) return;
    try {
      const r = await fetch('/api/jobs/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      toast(t('histDeleted', { n: r.deleted }), 'ok');
      loadHistory();
    } catch (e) {
      toast(e.message, 'err');
    }
  });
}

function updateHistMeta() {
  const meta = $('#histMeta');
  if (!meta) return;
  const n = $$('#history input[data-pick]').filter((c) => c.checked).length;
  meta.textContent = n ? t('histPicked', { n }) : '';
}

async function deleteOneJob(id) {
  if (!confirm(t('histConfirmOne'))) return;
  try {
    const r = await fetch('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    toast(t('histDeleted', { n: 1 }), 'ok');
    loadHistory();
  } catch (e) {
    toast(e.message, 'err');
  }
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
  $('#ecPanel').style.display = 'none';
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
        concurrency: 1, // 固定顺序执行（并发选择器已移除：实测并发会显著提高失败率）
        compareFrom: cmp.from || undefined,
        compareTo: cmp.to || undefined,
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

/* ---------------- 挂车 vs 非挂车对比 ---------------- */
const EC_KEYS = ['n', 'tv', 'avg', 'med', 'max', 'avgLikes', 'avgComments', 'avgShares', 'avgSaves', 'avgReposts', 'avgDuration', 'inter'];

function ecAgg(rows) {
  const n = rows.length;
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const tv = sum('views');
  const av = (t) => (n ? Math.round(t / n) : 0);
  const v = rows.map((r) => r.views).sort((a, b) => a - b);
  const med = v.length
    ? v.length % 2
      ? v[(v.length - 1) / 2]
      : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2)
    : 0;
  const lk = sum('likes'), cm = sum('comments'), sh = sum('shares'), sv = sum('saves'), rp = sum('reposts');
  return {
    n, tv, avg: av(tv), med, max: v.length ? v[v.length - 1] : 0,
    avgLikes: av(lk), avgComments: av(cm), avgShares: av(sh), avgSaves: av(sv), avgReposts: av(rp),
    avgDuration: av(sum('duration')),
    inter: tv ? (lk + cm + sh + sv + rp) / tv : 0,
  };
}

function renderEc(rows) {
  const panel = $('#ecPanel');
  const ec = ecAgg(rows.filter((r) => r.isEC));
  const non = ecAgg(rows.filter((r) => !r.isEC));
  if (!rows.length || (!ec.n && !non.n)) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  $('#ecMeta').textContent = `${ec.n} / ${non.n}`;
  const labels = t('ecMetrics') || [];
  $('#ecRows').innerHTML = EC_KEYS.map((k, i) => {
    const a = ec[k], b = non[k];
    const isPct = k === 'inter';
    const has = Number.isFinite(b) && b !== 0;
    const diff = has ? (a - b) / b : null;
    // 按用户偏好：不用红绿，正负靠字重/灰阶区分
    const cls = diff === null ? '' : diff >= 0 ? 'pos' : 'neg';
    return `<tr>
      <td>${esc(labels[i] || k)}</td>
      <td class="num">${isPct ? (a * 100).toFixed(2) + '%' : fmt(a)}</td>
      <td class="num">${isPct ? (b * 100).toFixed(2) + '%' : fmt(b)}</td>
      <td class="num ${cls}">${diff === null ? '—' : (diff >= 0 ? '+' : '') + (diff * 100).toFixed(1) + '%'}</td>
    </tr>`;
  }).join('');
}

function rowHtml(r, i) {
  return `<tr data-vid="${esc(r.vid)}">
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
      <td class="num">${fmt(r.reposts)}</td>
      <td class="num">${(r.inter * 100).toFixed(2)}%</td>
      <td class="num">${r.duration}s</td>
      <td class="ctr">${r.isEC ? `<span class="ec">${esc(t('yesShort'))}</span>` : '<span class="dim">—</span>'}</td>
      <td class="ctr"><button type="button" class="row-dl" data-vid="${esc(r.vid)}" title="${esc(t('colDownload'))}">⤓</button></td>
      <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(t('colOpen'))}</a></td>
    </tr>`;
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

  renderEc(state.rows);

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

  bindRowClick();
  $('#rows').innerHTML = rows.map((r, i) => rowHtml(r, i + 1)).join('');

  // 按账号分组：切换「分组显示」时插入分组标题行
  if (state.groupByAccount) {
    const tb = $('#rows');
    const groups = {};
    for (const r of rows) (groups[r.account] = groups[r.account] || []).push(r);
    const parts = [];
    for (const [acc, list] of Object.entries(groups)) {
      const tv = list.reduce((x, r) => x + (r.views || 0), 0);
      const tl = list.reduce((x, r) => x + (r.likes || 0), 0);
      parts.push(
        `<tr class="grp-tr"><td colspan="16"><span class="grp-name">@${esc(acc)}</span>` +
          `<span class="grp-meta">${list.length} ${t('items')} · ${fmt(tv)} ${t('colViews')} · ${fmt(tl)} ${t('colLikes')} · ${t('grpAvg')} ${fmt(Math.round(tv / list.length))}</span></td></tr>`
      );
      for (const r of list) parts.push(rowHtml(r, list.indexOf(r) + 1));
    }
    tb.innerHTML = parts.join('');
  } else {
    tb.innerHTML = rows.map((r, i) => rowHtml(r, i + 1)).join('');
  }
  bindRowClick();
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
      <input type="checkbox" data-pick="${esc(j.id)}" class="hist-pick">
      <span class="id">${esc(j.id.slice(-6))}</span>
      <span class="hs">${esc(j.handles.map((h) => '@' + h).join(' '))} <span style="color:#a8a8a8">${esc(j.from)}~${esc(j.to)}</span></span>
      <span class="badge ${j.status === 'done' ? 'ok' : j.status === 'error' ? 'err' : ''}">${j.rowCount || 0}</span>
      <button class="lk" data-open="${esc(j.id)}">${esc(t('view'))}</button>
      <button class="hist-x" data-del="${esc(j.id)}" title="${esc(t('histDelete'))}">×</button>
    </div>`
      )
      .join('') || `<div class="empty">${esc(t('noHistory'))}</div>`;
  $$('#history input[data-pick]').forEach((c) => c.addEventListener('change', updateHistMeta));
  $$('#history [data-del]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteOneJob(b.dataset.del);
    })
  );
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

/* ================= 视频详情（行点击展开，应用内全量；导出仍精简） ================= */
function bindRowClick() {
  const tb = $('#rows');
  if (!tb || tb.dataset.bound) return;
  tb.dataset.bound = '1';
  tb.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr');
    if (!tr || !tr.parentElement || tr.parentElement.id !== 'rows') return;
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('d-tr')) { next.remove(); return; }
    tb.querySelectorAll('.d-tr').forEach((x) => x.remove());
    const vid = tr.dataset.vid;
    const r = currentRows().find((x) => String(x.vid) === String(vid));
    if (!r) return;
    const d = document.createElement('tr');
    d.className = 'd-tr';
    d.innerHTML = `<td colspan="16"><div class="d-detail"><div class="d-grid">
      ${[['视频ID', r.vid], ['语种', r.lang || '—'], ['音乐', r.music || '—'], ['分辨率', r.resolution || '—'],
        ['挂车', r.isEC ? '是' : '—'], ['广告', r.isAd ? '是' : '—'], ['AIGC', r.isAIGC ? '是' : '—'],
        ['发布时间', r.date + ' ' + r.time], ['时长', r.duration + 's'],
        ['播放/点赞/评论', fmt(r.views) + ' / ' + fmt(r.likes) + ' / ' + fmt(r.comments)],
        ['分享/收藏/转发', fmt(r.shares) + ' / ' + fmt(r.saves) + ' / ' + fmt(r.reposts)],
        ['互动率', pct2(r.inter)], ['下载直链', r.playUrl ? '有（视频下载模块可用）' : 'item_list 未下发，详情页可补']]
        .map(([k, v]) => `<div><span class="dk">${esc(k)}</span><span class="dv">${esc(v)}</span></div>`).join('')}
      </div>
      <div class="d-actions">
        <button type="button" class="d-play" data-vid="${esc(r.vid)}">${esc(t('playerPlay'))}</button>
        <button type="button" class="d-ai" data-vid="${esc(r.vid)}">${esc(t('aiOneVideo'))}</button>
        <button type="button" class="d-remake" data-vid="${esc(r.vid)}">${esc(t('aiRemakeBtn'))}</button>
      </div>
      <div class="d-hist" id="dHist-${esc(r.vid)}">${esc(t('loading'))}…</div>
      <div class="d-out" id="dOut-${esc(r.vid)}"></div></div></td>`;
    tr.after(d);
    // 历史趋势（来自视频库）
    try {
      const v = await fetch('/api/videos/' + encodeURIComponent(r.vid)).then((x) => x.json());
      const h = v.history || [];
      d.querySelector('.d-hist').innerHTML = h.length > 1
        ? '<b>指标历史</b>：' + h.map((x) => `${x.date} 播放${fmt(x.views)}/赞${fmt(x.likes)}`).join(' → ')
        : '<b>指标历史</b>：只有一次快照，下次抓取同账号后这里会出现增长曲线';
    } catch (_) { d.querySelector('.d-hist').textContent = ''; }
  });
}
function pct2(n) { return (n * 100).toFixed(2) + '%'; }
function currentRows() { return state.rows || []; }

/* ================= 设置：模块按需装配 ================= */

function openSettings() {
  $('#settingsModal').style.display = 'flex';
  loadModules();
}
function closeSettings() {
  $('#settingsModal').style.display = 'none';
}

async function loadModules() {
  const box = $('#moduleList');
  box.innerHTML = `<div class="m-loading">${esc(t('modulesLoading'))}</div>`;
  $('#moduleHint').textContent = '';
  let data;
  try {
    data = await fetch('/api/modules').then((x) => x.json());
  } catch (e) {
    box.innerHTML = `<div class="m-loading">${esc(e.message)}</div>`;
    return;
  }
  if (data.indexError) $('#moduleHint').textContent = `${t('modulesIndexError')} ${data.indexError}`;
  if (!data.modules.length) {
    box.innerHTML = `<div class="m-loading">${esc(t('modulesNone'))}</div>`;
    return;
  }
  box.innerHTML = data.modules
    .map((m) => {
      const state = m.installed ? (m.enabled ? 'on' : 'off') : 'none';
      const badge =
        state === 'on'
          ? `<span class="m-badge on">${esc(t('modEnabled'))}</span>`
          : state === 'off'
            ? `<span class="m-badge">${esc(t('modInstalled'))}</span>`
            : `<span class="m-badge dim">${esc(t('modAvailable'))}</span>`;
      const upd = m.updateAvailable ? `<span class="m-badge upd">${esc(t('modUpdate'))} v${esc(m.version)}</span>` : '';
      const actions = m.installed
        ? `<button type="button" data-act="toggle" data-id="${esc(m.id)}" data-to="${m.enabled ? '0' : '1'}">${m.enabled ? esc(t('modDisable')) : esc(t('modEnable'))}</button>
           <button type="button" data-act="del" data-id="${esc(m.id)}">${esc(t('modDelete'))}</button>`
        : `<button type="button" data-act="install" data-id="${esc(m.id)}" class="primary">${esc(t('modInstall'))}</button>`;
      const req = (m.requires || []).length ? `<div class="m-meta">${esc(t('modRequires'))} ${esc(m.requires.join(', '))}</div>` : '';
      return `<div class="m-item">
        <div class="m-main">
          <div class="m-name">${esc(m.name)} <span class="m-ver">v${esc(m.installed ? m.installedVersion : m.version)}</span>${badge}${upd}</div>
          <div class="m-desc">${esc(m.description || '')}</div>
          ${req}
        </div>
        <div class="m-btns">${actions}</div>
      </div>`;
    })
    .join('');
}

$('#settingsModal').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const { act, id } = btn.dataset;
    btn.disabled = true;
    try {
      if (act === 'install') {
        const r = await fetch(`/api/modules/${id}/install`, { method: 'POST' }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        toast(`${t('modInstalledToast')} · ${t('modRestartHint')}`, 'ok');
      } else if (act === 'toggle') {
        const r = await fetch(`/api/modules/${id}/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: btn.dataset.to === '1' }),
        }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        toast(`${t('modToggleToast')} · ${t('modRestartHint')}`, 'ok');
      } else if (act === 'del') {
        const r = await fetch(`/api/modules/${id}`, { method: 'DELETE' }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        toast(t('modDeletedToast'), 'ok');
      }
      loadModules();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
    return;
  }
  if (e.target.id === 'settingsModal') closeSettings();
});
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsClose').addEventListener('click', closeSettings);
$('#modRefresh').addEventListener('click', loadModules);

/* ================= 模块前端：注册表 + 面板装载 ================= */

/** 模块用它把自己注册进来；主程序负责挂载到 #module-panels */
window.TTModule = (() => {
  const regs = new Map();
  return {
    register(def) { regs.set(def.id, def); },
    get(id) { return regs.get(id); },
    list() { return [...regs.values()]; },
  };
})();

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('加载失败 ' + src));
    document.head.appendChild(s);
  });
}

/** 把已启用模块的前端面板挂进主界面（单个失败不影响其它） */
/**
 * 模块不再挂在主页（用户要求：模块只在需要时出现，别在主页占一大块）。
 * 改为在「设置」弹窗里生成两组入口：登录 / 工具，点击后在小弹窗里打开对应功能。
 */
const LOGIN_MODULES = ['tiktok-login', 'seller-import'];
const LOGIN_LABEL = { 'tiktok-login': 'loginTiktok', 'seller-import': 'loginSeller' };

async function mountToolButtons() {
  let data;
  try {
    data = await fetch('/api/modules').then((x) => x.json());
  } catch (_) {
    return;
  }
  const enabled = (data.modules || []).filter((m) => m.installed && m.enabled);
  const loginHost = $('#loginActions');
  const toolHost = $('#toolActions');
  if (loginHost) {
    loginHost.innerHTML = enabled
      .filter((m) => LOGIN_MODULES.includes(m.id))
      .map((m) => `<button type="button" class="tool-open" data-id="${esc(m.id)}">${esc(m.name)}</button>`)
      .join('');
  }
  if (toolHost) {
    toolHost.innerHTML = enabled
      .filter((m) => !LOGIN_MODULES.includes(m.id))
      .map((m) => `<button type="button" class="tool-open" data-id="${esc(m.id)}">${esc(m.name)}</button>`)
      .join('');
  }
  document.querySelectorAll('.tool-open').forEach((b) =>
    b.addEventListener('click', () => openTool(b.dataset.id))
  );
}

mountToolButtons();



/* ================= 提示气泡（可关闭 / 可不再显示） ================= */
const TIP_NEVER = 'tt.tip.login.never';
const TIP_SESSION = 'tt.tip.login.sessionClosed';

function initTipBubble() {
  const b = $('#tipBubble');
  if (!b) return;
  const never = localStorage.getItem(TIP_NEVER) === '1';
  const closedThisSession = sessionStorage.getItem(TIP_SESSION) === '1';
  if (never || closedThisSession) return;
  b.style.display = 'flex';

  // × ：本次会话不再显示，下次启动会回来
  $('#tipClose').addEventListener('click', () => {
    sessionStorage.setItem(TIP_SESSION, '1');
    b.style.display = 'none';
  });
  // 不再显示：永久关闭
  $('#tipNever').addEventListener('click', () => {
    localStorage.setItem(TIP_NEVER, '1');
    b.style.display = 'none';
    toast(t('tipNeverDone'), 'ok');
  });
  // 登录：打开应用内小弹窗（不是浏览器窗口）
  $('#tipLogin').addEventListener('click', () => openTool('tiktok-login'));
}

/* ================= 登录弹窗（应用内小窗，承载登录类模块） ================= */
const LOGIN_MODULE_TITLE = { 'tiktok-login': 'loginTiktok', 'seller-import': 'loginSeller' };

async function openTool(moduleId) {
  const m = $('#loginModal');
  if (!m) return;
  const mods = await fetch('/api/modules').then((x) => x.json()).catch(() => ({ modules: [] }));
  const man = (mods.modules || []).find((m) => m.id === moduleId);
  $('#loginTitle').textContent = man ? man.name : t('loginTitle');
  const body = $('#loginBody');
  body.innerHTML = `<div class="m-loading">${esc(t('loading'))}</div>`;
  m.style.display = 'flex';
  try {
    await loadScript(`/modules/${moduleId}/module.js`);
    const reg = window.TTModule.get(moduleId);
    if (!reg || typeof reg.mount !== 'function') throw new Error(t('moduleNoFrontend'));
    body.innerHTML = '';
    reg.mount(body, { t, loginOnly: true });
  } catch (e) {
    body.innerHTML = `<div class="si-status err">${esc(e.message)}</div>`;
  }
}

function closeTool() {
  const m = $('#loginModal');
  if (m) m.style.display = 'none';
  $('#loginBody').innerHTML = '';
}

function initLoginModal() {
  const m = $('#loginModal');
  if (!m) return;
  $('#loginClose').addEventListener('click', closeTool);
  m.addEventListener('click', (e) => {
    if (e.target === m) closeTool();
  });
}

initTipBubble();
initLoginModal();


/* ================= 行内下载 / 详情内 AI 与复刻脚本 ================= */
function currentJobId() {
  return state.jobId || '';
}

async function downloadOne(vid) {
  const r = currentRows().find((x) => String(x.vid) === String(vid));
  if (!r) return toast(t('dlNeedPick'), 'err');
  toast(t('dlResolving'), 'ok');
  try {
    let item = { vid: r.vid, url: r.url, desc: r.desc, account: r.account, playUrl: r.playUrl };
    // 列表接口常常不下发直链 → 先去详情页解析（这一步是「没有可用的播放地址」的根治）
    if (!item.playUrl) {
      const rs = await fetch('/api/video-download/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'urls', input: r.url }),
      }).then((x) => x.json());
      if (rs.error) throw new Error(rs.error);
      if (!rs.items || !rs.items.length) throw new Error((rs.errors || []).join('; ') || '解析不到播放地址');
      item = rs.items[0];
    }
    const res = await fetch('/api/video-download/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [item], quality: 'best' }),
    }).then((x) => x.json());
    if (res.error) throw new Error(res.error);
    const poll = setInterval(async () => {
      const job = await fetch(`/api/video-download/jobs/${res.jobId}`).then((x) => x.json()).catch(() => null);
      if (!job) return;
      if (job.status === 'done' || job.status === 'error') {
        clearInterval(poll);
        const ok = (job.files || []).length;
        const bad = (job.errors || []).length;
        toast(t('dlFinished', { ok, bad }) + (bad ? ' · ' + job.errors[0] : ''), ok ? 'ok' : 'err');
      }
    }, 1500);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function aiOneVideo(vid, outEl) {
  outEl.innerHTML = `<div class="si-hint">${esc(t('aiWorking'))}</div>`;
  try {
    const r = await fetch('/api/ai-analyst/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vid }),
    }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    outEl.innerHTML = '<div class="ai-md">' + esc(r.analysis).replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/\n/g, '<br>') + '</div>';
  } catch (e) {
    outEl.innerHTML = `<div class="si-status err">${esc(e.message)}</div>`;
  }
}

async function remakeVideo(vid, outEl) {
  outEl.innerHTML = `<div class="si-hint">${esc(t('aiRemakeWorking'))}</div>`;
  try {
    const r = await fetch('/api/ai-analyst/remake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vid }),
    }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    outEl.innerHTML = '<div class="ai-md">' + esc(r.script).replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/\n/g, '<br>') + '</div>';
    // 标记「已生成」
    const btn = outEl.parentElement.querySelector('.d-remake');
    if (btn) btn.textContent = t('aiRemakeRegen');
  } catch (e) {
    outEl.innerHTML = `<div class="si-status err">${esc(e.message)}</div>`;
  }
}

document.addEventListener('click', (e) => {
  const dl = e.target.closest('.row-dl');
  if (dl) { e.stopPropagation(); downloadOne(dl.dataset.vid); return; }
  const ai = e.target.closest('.d-ai');
  if (ai) { aiOneVideo(ai.dataset.vid, document.getElementById('dOut-' + ai.dataset.vid)); return; }
  const rm = e.target.closest('.d-remake');
  if (rm) { remakeVideo(rm.dataset.vid, document.getElementById('dOut-' + rm.dataset.vid)); return; }
});

/* AI 时期分析（整体，常驻入口） */
/* 挂车对比：从弹窗打开（不再常驻主页） */
function initEcCompare() {
  const b = $('#ecCompareBtn');
  if (!b) return;
  b.addEventListener('click', () => {
    if (!currentJobId()) return toast(t('siNeedJob'), 'err');
    openTool('seller-import');
  });
}

function initAiPeriod() {
  const b = $('#aiPeriodBtn');
  if (!b) return;
  b.addEventListener('click', async () => {
    const jobId = currentJobId();
    if (!jobId) return toast(t('siNeedJob'), 'err');
    openTool('ai-analyst');
    // 打开工具弹窗后自动触发该任务的时期分析
    setTimeout(async () => {
      const body = $('#loginBody');
      if (!body) return;
      body.innerHTML = `<div class="si-hint">${esc(t('aiWorking'))}</div>`;
      try {
        const r = await fetch('/api/ai-analyst/brand', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
        }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        body.innerHTML = '<div class="ai-md">' + esc(r.analysis).replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/\n/g, '<br>') + '</div>';
      } catch (err) {
        body.innerHTML = `<div class="si-status err">${esc(err.message)}</div>`;
      }
    }, 400);
  });
}
initAiPeriod();


/* ================= 常用账号快捷分析（已登录账号 / 最近抓过） ================= */
async function initQuickAcc() {
  const host = $('#quickAcc');
  if (!host) return;
  // 只取「历史里最近用过的 3 个账号」——不碰 profile 目录（那里面是浏览器内部文件）
  let names = [];
  try {
    const jobs = await fetch('/api/jobs').then((x) => x.json());
    for (const j of jobs || []) {
      for (const h of j.handles || []) {
        // TikTok 用户名只含小写字母/数字/._，其它一律是脏数据（例如浏览器内部目录名）
        if (!h || !/^[a-z0-9._]{2,30}$/.test(h)) continue;
        if (!names.includes(h)) names.push(h);
        if (names.length >= 3) break;
      }
      if (names.length >= 3) break;
    }
  } catch (_) {}
  if (!names.length) { host.style.display = 'none'; return; }
  host.innerHTML =
    `<span class="quick-label">${esc(t('quickAcc'))}</span>` +
    names.map((n) => `<button type="button" class="quick-btn" data-h="${esc(n)}">@${esc(n)}</button>`).join('');
  host.querySelectorAll('.quick-btn').forEach((b) =>
    b.addEventListener('click', () => {
      const ta = $('#handles');
      const cur = ta.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
      if (!cur.includes(b.dataset.h)) cur.push(b.dataset.h);
      ta.value = cur.join('\n');
    })
  );
}
initQuickAcc();



/* ================= 内置播放器（应用内播放，绝不走系统浏览器） ================= */
function closePlayer() {
  const m = $('#playerModal');
  if (m) m.style.display = 'none';
  const v = $('#playerVideo');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
}

async function playVideo(vid) {
  const r = currentRows().find((x) => String(x.vid) === String(vid));
  const m = $('#playerModal');
  if (!r || !m) return;
  $('#playerTitle').textContent = (r.desc || r.vid).slice(0, 50);
  $('#playerInfo').textContent = t('playerLoading');
  m.style.display = 'flex';
  try {
    const res = await fetch('/api/video-download/play-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: r.url, vid: r.vid }),
    }).then((x) => x.json());
    if (res.error) throw new Error(res.error);
    const v = $('#playerVideo');
    v.src = res.playUrl;
    v.poster = res.cover || '';
    $('#playerInfo').textContent = `@${r.account} · ${res.duration || r.duration}s · ${t('playerNoWatermark')}`;
    v.play().catch(() => {});
  } catch (e) {
    $('#playerInfo').innerHTML = `<span class="tl-msg err">${esc(e.message)}</span>`;
  }
}

function initPlayer() {
  const m = $('#playerModal');
  if (!m) return;
  $('#playerClose').addEventListener('click', closePlayer);
  m.addEventListener('click', (e) => { if (e.target === m) closePlayer(); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.d-play');
    if (b) playVideo(b.dataset.vid);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePlayer(); });
}

/* ================= 存储位置 ================= */
async function initStorage() {
  const input = $('#storageDir');
  if (!input) return;
  try {
    const d = await fetch('/api/settings/storage').then((x) => x.json());
    input.value = d.downloadDir || '';
    if (!input.value) input.placeholder = t('storageDefault');
  } catch (_) {}
  $('#storageSave').addEventListener('click', async () => {
    try {
      const r = await fetch('/api/settings/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadDir: input.value.trim() }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      toast(t('storageSaved'), 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  });
}

initPlayer();
initStorage();

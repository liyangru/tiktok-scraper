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
  ranges: null, // { currentFrom, currentTo, compareFrom, compareTo }
  periodCompare: null, // 服务端算好的「本期 vs 对比期」
  tab: '__all__',
  search: '',
  sortKey: 'views',
  sortDir: 'desc',
  poll: 0,
  busy: false,
  /* 模块感知（Round 6）：AI 入口只在装了 AI 模块后出现 */
  aiEnabled: false,
  /* 行勾选（批量下载用） */
  picking: false,
  picked: new Set(),
  /* 搜索框：文本搜索 / 链接解析两种模式 */
  searchRefs: null,
  /* 本期是哪种预设期次（week/month/quarter/…）—— 决定对比期是否按「前一自然期」推算 */
  rangeKind: '',
  /* 视频明细是否处于「全部展开详情」状态 */
  expandAll: false,
};

/**
 * 判断搜索框里是不是「视频链接 / 纯 vid」。
 * 链接：含 http(s):// 或 tiktok.com 域名；vid：15 位以上纯数字（TikTok id 是 19 位）。
 * 多个用空格/逗号分隔 —— 和后端 parseVideoRef 的切分规则一致。
 */
function parseSearchRefs(raw) {
  const parts = String(raw || '')
    .split(/[\s,;，；]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!parts.length) return [];
  const isLink = (s) => /^https?:\/\//i.test(s) || /(^|\.)(tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com)/i.test(s);
  const isVid = (s) => /^\d{15,22}$/.test(s);
  const hits = parts.filter((s) => isLink(s) || isVid(s));
  // 必须**整段**都是链接/vid 才当解析用；夹杂其它词就当普通文本搜索
  return hits.length === parts.length ? hits : [];
}

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
  //同步给主进程：下次启动的闪屏用同一种语言（主进程读不到 localStorage）
  fetch('/api/settings/core', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang }),
  }).catch(() => {});
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
    // 启动时内置模块源自动升级过 → 提示一次（sessionStorage 防重复）
    if (lastHealth.autoUpgraded && lastHealth.autoUpgraded.length
        && sessionStorage.getItem('ttUpgradedToast') !== '1') {
      sessionStorage.setItem('ttUpgradedToast', '1');
      toast(t('autoUpgradedToast') + ` (${lastHealth.autoUpgraded.map((x) => x.id + '@' + x.to).join(', ')})`, 'ok');
    }
  } catch (e) {
    lastHealth = { chromeFound: false, error: true };
  }
  renderBrowserChip(lastHealth);
}

function renderBrowserChip(h) {
  const el = $('#browserChip');
  if (!el) return;
  el.className = 'browser-chip ok';
  el.innerHTML = '<span class="dot"></span><span>本地数据模式 · 无浏览器</span>';
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
    const raw = e.target.value.trim();
    // 搜索框同时吃「文案/账号/vid」和「视频链接」：
    // 一旦看起来是链接/纯数字 vid，就切成「解析并入库」模式，不做文本过滤
    const asRefs = parseSearchRefs(raw);
    if (asRefs.length) {
      state.search = '';
      state.searchRefs = asRefs;
      renderResults();
      const hint = $('#searchHint');
      if (hint) {
        hint.textContent = t('searchLinkHint', { n: asRefs.length });
        hint.style.display = 'block';
      }
      $('#dlResolveBtn2').classList.add('on');
      return;
    }
    state.searchRefs = null;
    state.search = raw.toLowerCase();
    const hint = $('#searchHint');
    if (hint) hint.style.display = 'none';
    $('#dlResolveBtn2').classList.remove('on');
    renderResults();
  });
  // 回车 = 解析并加入视频明细
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state.searchRefs && state.searchRefs.length) {
      e.preventDefault();
      resolveRefsIntoRows(state.searchRefs);
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') start();
  });

  $$('[data-range]').forEach((b) =>
    b.addEventListener('click', () => {
      const t0 = bangkokToday();
      const y = Number(t0.slice(0, 4));
      const m = Number(t0.slice(5, 7));
      const r = b.dataset.range;
      const pad = (n) => String(n).padStart(2, '0');
      // 记录本次选中的是哪种期次 —— 对比期建议值要按「前一自然期」给，而不是同天数往前推
      const set = (f, to, kind) => {
        $('#from').value = f;
        $('#to').value = to;
        state.rangeKind = kind || '';
        syncCompare(); // 快捷日期改了本期 → 对比期建议值要跟着重算，否则会重叠
      };
      if (r === 'thisMonth') set(t0.slice(0, 8) + '01', t0, 'month');
      else if (r === 'lastMonth') {
        const pm = m === 1 ? 12 : m - 1;
        const py = m === 1 ? y - 1 : y;
        const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
        set(`${py}-${pad(pm)}-01`, `${py}-${pad(pm)}-${pad(last)}`, 'month');
      } else if (r === 'lastWeek') {
        // 上周（自然周：上周一~ 上周日）
        const now = new Date(t0 + 'T00:00:00Z');
        const dow = now.getUTCDay() === 0 ? 7 : now.getUTCDay(); // 周一=1 … 周日=7
        const thisMon = new Date(now.getTime() - (dow - 1) * 86400000);
        const lastMon = new Date(thisMon.getTime() - 7 * 86400000);
        const lastSun = new Date(thisMon.getTime() - 86400000);
        set(lastMon.toISOString().slice(0, 10), lastSun.toISOString().slice(0, 10), 'week');
      } else if (r === 'last90') {
        set(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10), t0, 'days');
      } else if (/^q[1-4]$/.test(r)) {
        const q = Number(r[1]);
        const sm = (q - 1) * 3 + 1;
        const em = sm + 2;
        const lastDay = new Date(Date.UTC(y, em, 0)).getUTCDate();
        set(`${y}-${pad(sm)}-01`, `${y}-${pad(em)}-${pad(lastDay)}`, 'quarter');
      } else if (r === 'all') set('2020-01-01', t0, '');
    })
  );

  initCompare();
  checkHealth();
  loadHistory();
}

/* ================= 对比日期（小窗，默认同期天数） ================= */
/* touched = 用户手动改过对比期。
   为 false 时说明里面的值还是系统建议的，本期一变就要跟着重算；
   否则用户是刻意填的，不能再被本期覆盖掉。 */
const cmp = { from: '', to: '', touched: false };

function daysBetween(a, b) {
  if (!a || !b) return 0;
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000) + 1;
}

/** 两段日期的重叠部分；没重叠返回 n: 0 */
function overlapDays(a1, a2, b1, b2) {
  if (!a1 || !a2 || !b1 || !b2) return { n: 0, from: null, to: null };
  const s = a1 > b1 ? a1 : b1;
  const e = a2 < b2 ? a2 : b2;
  if (s > e) return { n: 0, from: null, to: null };
  return { n: daysBetween(s, e), from: s, to: e };
}

/** 上一个自然月：给定 YYYY-MM-DD，返回 {from,to}（整月，含首尾） */
function prevMonth(f) {
  const y = Number(f.slice(0, 4));
  const m = Number(f.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const p = (n) => String(n).padStart(2, '0');
  return { from: `${py}-${p(pm)}-01`, to: `${py}-${p(pm)}-${p(last)}` };
}
/** 上一个自然季度 */
function prevQuarter(f) {
  const y = Number(f.slice(0, 4));
  const m = Number(f.slice(5, 7));
  const q = Math.floor((m - 1) / 3);           // 本期所在季度，0-based
  const pq = q === 0 ? 4 : q;// 上一个季度，1~4
  const py = q === 0 ? y - 1 : y;
  const p = (n) => String(n).padStart(2, '0');
  const sm = (pq - 1) * 3 + 1;
  const em = sm + 2;
  const last = new Date(Date.UTC(py, em, 0)).getUTCDate();
  return { from: `${py}-${p(sm)}-01`, to: `${py}-${p(em)}-${p(last)}` };
}
/** 上一个自然周（周一~周日），以 f 所在的那一周为「本期」 */
function prevWeek(f) {
  const d = new Date(f + 'T00:00:00Z');
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  const thisMon = new Date(d.getTime() - (dow - 1) * 86400000);
  const lastMon = new Date(thisMon.getTime() - 7 * 86400000);
  const lastSun = new Date(thisMon.getTime() - 86400000);
  return { from: lastMon.toISOString().slice(0, 10), to: lastSun.toISOString().slice(0, 10) };
}

function suggestCompare() {
  const f = $('#from').value;
  const to = $('#to').value;
  if (!f || !to) return null;

  // 用户点的是「周 / 月 / 季度」这类预设 → 对比期给**前一自然期**，
  // 而不是「往前推同样天数」—— 8/1~8/31 的对比期应该是 7/1~7/31，8/3~8/9 才是 7/27~8/2。
  const kind = state.rangeKind;
  if (kind === 'month') return Object.assign(prevMonth(f), { days: 0 });
  if (kind === 'quarter') return Object.assign(prevQuarter(f), { days: 0 });
  if (kind === 'week') return Object.assign(prevWeek(f), { days: 0 });

  // 其余情况（自定义日期、近 90 天等）：与本期同天数、紧邻本期之前
  const n = daysBetween(f, to);
  const end = new Date(new Date(f + 'T00:00:00Z').getTime() - 86400000);
  const start = new Date(end.getTime() - (n - 1) * 86400000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10), days: n };
}

/** 把 cmp 的当前值刷到按钮和输入框上（用户手动改过就不覆写输入框） */
function syncCompareUi() {
  const btn = $('#cmpBtn');
  if (btn) {
    btn.textContent =
      cmp.from && cmp.to ? `${t('cmpBtn')} ${cmp.from.slice(5)}~${cmp.to.slice(5)}` : t('cmpBtn');
  }
  const f = $('#cmpFrom');
  const to = $('#cmpTo');
  if (!cmp.touched) {
    if (f) f.value = cmp.from || '';
    if (to) to.value = cmp.to || '';
  }
}

/** 本期变了：只要对比期还是系统建议值，就跟着重算。
    这一条挡掉了「改了本期、对比期还停在旧建议值」造成的重叠。 */
function syncCompare() {
  if (cmp.touched) return;
  const s = suggestCompare();
  if (!s) return;
  cmp.from = s.from;
  cmp.to = s.to;
  syncCompareUi();
}

function initCompare() {
  const m = $('#cmpModal');
  if (!m) return;
  const close = () => { m.style.display = 'none'; };
  $('#cmpClose').addEventListener('click', close);
  m.addEventListener('click', (e) => { if (e.target === m) close(); });
  $('#cmpBtn').addEventListener('click', () => {
    const s = suggestCompare();
    if (s && !cmp.touched) { $('#cmpFrom').value = s.from; $('#cmpTo').value = s.to; }
    $('#cmpStatus').textContent = s ? (s.days ? t('cmpSuggest', { n: s.days }) : t('cmpSuggestPeriod')) : '';
    m.style.display = 'flex';
  });

  // 用户一动手改对比期就标记为「刻意填的」，之后本期再变也不覆盖它
  ['#cmpFrom', '#cmpTo'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('change', () => { cmp.touched = true; });
  });

  $('#cmpOk').addEventListener('click', () => {
    const f = $('#cmpFrom').value;
    const to = $('#cmpTo').value;
    if (!f || !to) { $('#cmpStatus').textContent = t('cmpNeedBoth'); return; }
    if (f > to) { $('#cmpStatus').textContent = t('cmpBadRange'); return; }
    // 两期重叠 → 同一批视频会同时落进两期，算出来的 delta 全是错的。
    // 与其静默挑一个归属规则把问题盖掉，不如在这里直接挡住。
    const ov = overlapDays($('#from').value, $('#to').value, f, to);
    if (ov.n > 0) {
      $('#cmpStatus').textContent = t('cmpOverlap', { from: ov.from, to: ov.to, n: ov.n });
      return;
    }
    cmp.from = f;
    cmp.to = to;
    syncCompareUi();
    close();
    toast(t('cmpSet', { from: cmp.from, to: cmp.to }), 'ok');
  });

  $('#cmpClear').addEventListener('click', () => {
    cmp.from = cmp.to = '';
    cmp.touched = false; // 清掉后重新变回「系统建议」，本期再变会跟着走
    $('#cmpFrom').value = $('#cmpTo').value = '';
    $('#cmpBtn').textContent = t('cmpBtn');
    close();
  });

  // 本期一变就自动跟随（用户手动改过对比期时，syncCompare 内部直接 return）
  ['#from', '#to'].forEach((sel) => {
    const el = $(sel);
    // 手动改日期 = 用户自己在定义期次，不再按预设的「前一自然期」推算
    if (el) el.addEventListener('change', () => { state.rangeKind = ''; syncCompare(); });
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

/* ================= 加载动画层（抓取 / 解析期间） ================= */
let loadTimer = 0;
let loadT0 = 0;

/**
 * 开/关加载动画。
 * stage: 'scrape' 抓取 | 'resolve' 解析链接 | 'download' 下载
 * detail: 副标题（如当前在跑哪个账号）
 */
function showLoader(stage, detail) {
  const veil = $('#loadVeil');
  if (!veil) return;
  veil.style.display = 'flex';
  veil.classList.toggle('indet', stage !== 'scrape');
  state.loadStage = stage;
  $('#loadTitle').textContent = t('loadTitle' + (stage.charAt(0).toUpperCase() + stage.slice(1)));
  $('#loadSub').textContent = detail || t('loadWait');
  $('#loadSteps').innerHTML = Array.from({ length: 3 }, () => '<span></span>').join('');
  if (!loadTimer) {
    loadT0 = Date.now();
    loadTimer = setInterval(() => {
      const s = Math.floor((Date.now() - loadT0) / 1000);
      const el = $('#loadTime');
      if (el) el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 1000);
  }
}
function setLoaderProgress(pct, detail) {
  const fill = $('#loadFill');
  if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  const p = $('#loadPct');
  if (p) p.textContent = Math.round(pct) + '%';
  if (detail) $('#loadSub').textContent = detail;
  const steps = $('#loadSteps');
  if (steps) {
    const n = steps.children.length || 3;
    const lit = Math.round((pct / 100) * n);
    Array.from(steps.children).forEach((c, i) => {
      c.className = i < lit ? 'done' : i === lit ? 'on' : '';
    });
  }
}
function hideLoader() {
  const veil = $('#loadVeil');
  if (veil) veil.style.display = 'none';
  if (loadTimer) {
    clearInterval(loadTimer);
    loadTimer = 0;
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
  const pcEl = $('#pcPanel');
  if (pcEl) pcEl.style.display = 'none';
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
  const handles = $('#handles').value; // 本地数据模式：用户名输入框已隐藏，忽略
  $('#log').innerHTML = '';
  seenEvents = new Set();
  state.rows = [];
  state.summary = [];
  state.ranges = null;
  state.periodCompare = null;
  setBusy(true);
  showSkeleton();
  showLoader('scrape', t('loadBoot'));

  try {
    const res = await fetch(API + '/api/load-db', {
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
    hideLoader();
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
  hideLoader();
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
          state.ranges = {
            currentFrom: j.currentFrom,
            currentTo: j.currentTo,
            compareFrom: j.compareFrom,
            compareTo: j.compareTo,
          };
          state.periodCompare = j.periodCompare || null;
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

  // 加载动画：百分比 + 当前正在跑哪个账号
  const totalN = j.handles.length;
  const doneN = (j.accounts || []).filter((a) => a.state === 'done' || a.state === 'failed').length;
  const running = (j.accounts || []).find((a) => a.state === 'running' || a.state === 'retrying');
  const detail = running
    ? `@${running.handle} · ${t('running')} ${running.found || 0}`
    : `${t('doneN', { n: doneN })} / ${totalN}`;
  if (state.busy) {
    if (loadTimer) setLoaderProgress(totalN ? (doneN / totalN) * 100 : 0, detail);
    else showLoader('scrape', detail);
  }
  // job.from/to 只是「本期 ∪ 对比期」的并集，显示它看不出期次 → 分开显示
  const curFrom = j.currentFrom || j.from;
  const curTo = j.currentTo || j.to;
  $('#resultMeta').textContent =
    j.compareFrom && j.compareTo
      ? `${curFrom}~${curTo} · ${t('pcCmp')} ${j.compareFrom}~${j.compareTo}`
      : `${curFrom} ~ ${curTo}`;
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
    const va = a[k] === null || a[k] === undefined ? -1 : a[k];
    const vb = b[k] === null || b[k] === undefined ? -1 : b[k];
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}

/* ---------------- 挂车 vs 非挂车对比 ---------------- */
/* 口径说明：不只平均 —— 中位数（抗爆款 outliers）、互动率（总互动/总播放）、
   条均互动（每条视频的互动量）都在列。对比和 AI 分析共用这套口径。 */
const EC_KEYS = ['n', 'tv', 'avg', 'med', 'max', 'avgLikes', 'avgComments', 'avgShares', 'avgSaves', 'avgReposts', 'avgDuration', 'inter', 'avgInter'];

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
    avgInter: av(lk + cm + sh + sv + rp),
  };
}

/** 挂车对比：渲染到**弹窗**（按钮打开，不常驻主页） */
function renderEc(rows) {
  const ec = ecAgg(rows.filter((r) => r.isEC));
  const non = ecAgg(rows.filter((r) => !r.isEC));
  if (!rows.length || (!ec.n && !non.n)) return false;
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
  return true;
}

/* 本期 vs 对比期：只对设了对比期的任务显示 */
function renderPeriodCompare() {
  const panel = $('#pcPanel');
  if (!panel) return;
  const pc = state.periodCompare;
  if (!pc || !pc.hasCompare) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';

  const rg = state.ranges || {};
  $('#pcMeta').textContent = pc.compare.n
    ? `${pc.current.from || rg.currentFrom}~${pc.current.to || rg.currentTo} (${pc.current.n}) · ${pc.compare.from || rg.compareFrom}~${pc.compare.to || rg.compareTo} (${pc.compare.n})`
    : `${rg.currentFrom}~${rg.currentTo} · ${t('pcNone')}`;

  const labels = t('ecMetrics') || [];
  $('#pcRows').innerHTML = EC_KEYS.map((k, i) => {
    const a = pc.current[k];
    const b = pc.compare[k];
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

/* ================= AI 经营简报（默认自动出，在概览里，不用点击） ================= */
let aiBriefSeq = 0;
async function loadAiBrief(force) {
  const el = $('#aiBrief');
  if (!el) return;
  const jobId = currentJobId();
  if (!jobId) { el.style.display = 'none'; return; }
  const seq = ++aiBriefSeq;
  el.style.display = 'block';
  el.innerHTML = `<div class="ab-head"><span class="ab-title">${esc(t('aiBriefTitle'))}</span>
    <span class="ab-hint">${esc(t('aiBriefWorking'))}</span></div>
    <div class="ab-skel"><i></i><i></i><i></i></div>`;
  try {
    const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/ai-brief${force ? '' : ''}`, { cache: 'no-store' }).then((x) => x.json());
    if (seq !== aiBriefSeq) return; // 已切换到其它任务，丢弃
    if (r.error) throw new Error(r.error);
    el.innerHTML = `<div class="ab-head"><span class="ab-title">${esc(t('aiBriefTitle'))}</span>
      <span class="ab-hint">${r.cached ? esc(t('aiBriefCached')) : ''}</span>
      <button type="button" class="ab-regen" id="aiBriefRegen">${esc(t('aiBriefRegen'))}</button></div>
      <div class="ai-md">${esc(r.brief).replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</div>`;
    $('#aiBriefRegen').addEventListener('click', async () => {
      try {
        await fetch(`/api/jobs/${encodeURIComponent(jobId)}/ai-brief`, { method: 'DELETE' }).then((x) => x.json());
      } catch (_) {}
      loadAiBrief();
    });
  } catch (e) {
    if (seq !== aiBriefSeq) return;
    el.innerHTML = `<div class="ab-head"><span class="ab-title">${esc(t('aiBriefTitle'))}</span></div>
      <div class="si-status err">${esc(e.message)}</div>`;
  }
}

function rowHtml(r, i) {
  const picked = state.picked.has(String(r.vid));
  /* Round 11 精简排版：封面 + 文案（日期并入文案下方小字）+ 核心指标，
     去掉账号列（tab 已经过滤账号）、收藏/转发/时长/打开链接（全部在展开详情里），
     表格不再需要横向滚动。 */
  const cover = r.cover
    ? `<img class="row-cover" src="${esc(r.cover)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
    : `<div class="row-cover empty-cover">▶</div>`;
  /* ⚠️ 列数必须和 thead 严格一致（当前 12 列）。
     Round 11 精简时把日期并进了文案下方小字，却没删 thead 的日期列 ——
     结果表头 12 列、数据行 11 列，从第 5 列起整行错位：
     播放量跑到「日期」列下、下载按钮跑到「挂车」列下，看起来就是「数据缺了」。
     现在日期单独成列（且保留排序），小字只留时长与对比期标记，避免重复。 */
  const subBits = [];
  if (r.duration) subBits.push(r.duration + 's');
  if (r.period === 'compare') subBits.push(`<span class="pd-cmp">${esc(t('periodCmp'))}</span>`);
  return `<tr data-vid="${esc(r.vid)}">
      <td class="ctr pick-col"><input type="checkbox" class="row-pick" data-vid="${esc(r.vid)}"${picked ? ' checked' : ''}></td>
      <td class="num dim">${i + 1}</td>
      <td class="ctr cover-col">${cover}</td>
      <td class="desc"><div class="d">${esc(r.desc) || `<span style="color:var(--ink-3)">${esc(t('noCaption'))}</span>`}</div>
        ${subBits.length ? `<div class="sub-line">${subBits.join(' · ')}</div>` : ''}</td>
      <td class="date-col"><div class="dt">${esc(r.date)}</div>${r.time ? `<div class="dt-t">${esc(r.time)}</div>` : ''}</td>
      <td class="num strong">${fmt(r.views)}</td>
      <td class="num">${fmt(r.likes)}</td>
      <td class="num">${fmt(r.comments)}</td>
      <td class="num">${fmt(r.shares)}</td>
      <td class="num">${r.inter === null || r.inter === undefined ? '<span class="dim">—</span>' : (r.inter * 100).toFixed(2) + '%'}</td>
      <td class="ctr">${r.isEC ? `<span class="ec">${esc(t('yesShort'))}</span>` : '<span class="dim">—</span>'}</td>
      <td class="ctr"><button type="button" class="row-dl" data-vid="${esc(r.vid)}" title="${esc(t('colDownload'))}">⤓</button></td>
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
      <div class="k">@${esc(a.handle)}${a.nickname ? ' · ' + esc(a.nickname) : ''}
        <button type="button" class="card-dl" data-h="${esc(a.handle)}" title="${esc(t('cardDownload'))}">⤓</button></div>
      <div class="v">${fmt(a.n)} <span style="font-size:12px;font-weight:400;color:#7f7f7f">${esc(t('items'))}</span></div>
      <div class="m">${esc(t('views'))} ${fmt(a.tv)} · ${esc(t('avgViews'))} ${fmt(a.avg)}<br>
      ${esc(t('maxViews'))} ${fmt(a.max)} · ${esc(t('saves'))} ${fmt(a.saves)}<br>
      ${esc(t('colEngage'))} ${(a.inter * 100).toFixed(2)}%${a.stats && a.stats.followerCount ? ' · ' + esc(t('followers')) + ' ' + fmt(a.stats.followerCount) : ''}</div>
    </div>`
    )
    .join('');
  $$('#cards .card-dl').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadHandleVideos(b.dataset.h);
    })
  );

  renderPeriodCompare();
  loadAiBrief(); // Round 11：AI 经营分析默认自动出，不需要点击
  renderCreatorTrend(); // 创作中心账号趋势（真实日度序列，趋势图的第二个数据来源）

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
        (r.tags || '').toLowerCase().includes(state.search) ||
        String(r.vid || '').includes(state.search)
    );
  }
  rows = sortRows(rows);

  const tb = $('#rows');
  tb.innerHTML = rows.map((r, i) => rowHtml(r, i)).join('');
  setExpandAll(false); // 重渲染后旧的展开行都没了，按钮状态要跟着复位
  bindRowClick();
  bindRowPicks();
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
      <span class="hs">${esc(j.handles.map((h) => '@' + h).join(' '))} <span style="color:#a8a8a8">${esc(j.currentFrom || j.from)}~${esc(j.currentTo || j.to)}${j.compareFrom && j.compareTo ? ' · ' + esc(t('pcCmp')) : ''}</span></span>
      <span class="badge ${j.status === 'done' ? 'ok' : j.status === 'error' ? 'err' : ''}">${j.rowCount || 0}</span>
      <button class="lk" data-open="${esc(j.id)}">${esc(t('view'))}</button>
      <button class="hist-x" data-del="${esc(j.id)}" title="${esc(t('histDelete'))}">×</button>
    </div>`
      )
      .join('') || `<div class="empty">${esc(t('noHistory'))}</div>`;
  $$('#history input[data-pick]').forEach((c) => c.addEventListener('change', updateHistMeta));
  $$('#history [data-del]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteOneJob(b.dataset.del);
    });
    // hover 才显示，触屏/没 hover 的环境下可能点不到 —— 按下就直接触发
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') {
        e.stopPropagation();
        deleteOneJob(b.dataset.del);
      }
    });
  });
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

/* ================= 视频详情（行点击展开：内嵌固定播放器 + 全量字段 + 双平台指标） ================= */
/**
 * 极简 SVG 折线（指标趋势）—— 不引图表库，保持轻量。
 * 用户反馈两条，这里一起改掉：
 *   ① 线太粗 → 固定 1px，并加 non-scaling-stroke（SVG 被拉伸时线宽不变）
 *   ② 只有一个来源看不出趋势 → 每个指标**各自一条独立量纲的小图**，
 *      并标注数据来源（TikTok 快照 / 创作中心）。
 *      ⚠️ 绝不把「播放」和「完播率」塞进同一个纵轴 —— 那样得到的是一条假趋势。
 */
function trendLine(pts, w = 300, h = 40) {
  const vals = pts.map((p) => p.v);
  if (vals.length < 2) return '';
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const span = max - min || 1;
  const xy = vals.map((v, i) => [
    (i / (vals.length - 1)) * (w - 10) + 5,
    h - 7 - ((v - min) / span) * (h - 14),
  ]);
  const path = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const dots = xy
    .map(([x, y]) => `<circle class="spark-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.7"></circle>`)
    .join('');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <line class="spark-axis" x1="5" y1="${h - 7}" x2="${w - 5}" y2="${h - 7}"></line>
    <polyline fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round" stroke-linecap="round"
      vector-effect="non-scaling-stroke" points="${path}"></polyline>
    ${dots}
  </svg>`;
}

/**
 * 逐条视频的趋势里展示哪些指标、各自来自哪个平台。
 * ⚠️ 实测过：创作中心**逐条视频**只给 play/like/comment/share/favorite（TikTok 抓取已有），
 *    所以逐条视频的第二个数据来源是**卖家中心**（完播率 / 点击率 / 商品点击 / 涨粉），
 *    这些由 seller-import 模块同步、核心写进 videodb 历史点后才画得成曲线。
 */
const TREND_METRICS = [
  { key: 'views', label: 'colViews', src: 'tiktok' },
  { key: 'likes', label: 'colLikes', src: 'tiktok' },
  { key: 'comments', label: 'colComments', src: 'tiktok' },
  { key: 'shares', label: 'colShares', src: 'tiktok' },
  { key: 'completionRate', label: 'sfFinish', src: 'seller', unit: '%' },
  { key: 'ctr', label: 'sfCtr', src: 'seller', unit: '%' },
  { key: 'productClicks', label: 'sfClicks', src: 'seller' },
  { key: 'newFans', label: 'sfNewFans', src: 'seller' },
];

/**
 * 渲染「指标趋势」：多指标 × 多来源。
 * 数据来源有两个 —— ① TikTok 抓取快照（播放/点赞/评论/分享）② 创作中心同步（完播率/平均观看时长/涨粉）。
 * 两边的点都沉淀在 data/videodb.json 的 history 里，日期相同会自动合并成一个点。
 */
async function renderTrend(el, r) {
  let v = null;
  try {
    v = await fetch('/api/videos/' + encodeURIComponent(r.vid)).then((x) => x.json());
  } catch (_) {}
  const h = (v && v.history) || [];
  const items = [];
  for (const m of TREND_METRICS) {
    const pts = h
      .filter((p) => typeof p[m.key] === 'number' && isFinite(p[m.key]))
      .map((p) => ({ d: p.date, v: p[m.key] }));
    if (pts.length >= 2) items.push(Object.assign({}, m, { pts }));
  }

  const srcName = (s) => t(s === 'seller' ? 'trendSrcSeller' : s === 'creator' ? 'trendSrcCreator' : 'trendSrcTiktok');
  const first = h[0] && h[0].date;
  const lastD = h[h.length - 1] && h[h.length - 1].date;

  let head = `<div class="trend-head"><b>${esc(t('trendTitle'))}</b>`;
  head += `<span class="trend-src">${esc(srcName('tiktok'))} · ${esc(t('trendSnapN', { n: h.length }))}`;
  if (first && lastD) head += `（${esc(first)} ~ ${esc(lastD)}）`;
  head += `</span>`;
  head += `</div>`;

  if (!items.length) {
    el.innerHTML =
      `<div class="trend-box">${head}<div class="trend-empty">${esc(t('trendOnlyOne'))}</div></div>`;
    return;
  }

  const body = items
    .map((m) => {
      const vals = m.pts.map((p) => p.v);
      const a = vals[0];
      const b = vals[vals.length - 1];
      const fmtV = (x) => (m.unit === '%' ? x.toFixed(1) + '%' : m.unit === 's' ? x.toFixed(1) + 's' : fmt(x));
      const delta = a ? ((b - a) / a) * 100 : 0;
      return `<div class="trend-item">
        <div class="trend-legend"><b>${esc(t(m.label))}</b><span class="lg-src">${esc(srcName(m.src))}</span>
          ${esc(fmtV(a))} → ${esc(fmtV(b))}
          <span class="${delta >= 0 ? 'up' : 'down'}">(${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)</span>
        </div>
        <div class="trend-chart">${trendLine(m.pts)}</div>
      </div>`;
    })
    .join('');

  el.innerHTML = `<div class="trend-box">${head}${body}</div>`;
}

/**
 * 构造一条视频的详情行（跨所有列）。
 * 单行展开与表头「全部展开详情」共用这一份，避免两套详情渲染逻辑各自漂移。
 * 跨列单元格宽度自动等于表宽，不影响 table-layout 下的列宽计算。
 */
function buildDetailRow(r, withMedia) {
  const d = document.createElement('tr');
  d.className = 'd-tr';
  // 双平台独有指标（卖家中心 / 创作中心同步来的字段）
  const sf = [];
  if (r.gmv !== undefined) sf.push([t('sfGmv'), fmt(r.gmv)]);
  if (r.orders !== undefined) sf.push([t('sfOrders'), fmt(r.orders)]);
  if (r.productClicks !== undefined) sf.push([t('sfClicks'), fmt(r.productClicks)]);
  if (r.gpm !== undefined) sf.push([t('sfGpm'), fmt(r.gpm)]);
  if (r.finishRate !== undefined) sf.push([t('sfFinish'), r.finishRate + '%']);
  if (r.completionRate !== undefined) sf.push([t('sfFinish'), r.completionRate + '%']);
  if (r.avgWatchTime !== undefined) sf.push([t('sfWatch'), r.avgWatchTime + 's']);
  if (r.newFans !== undefined) sf.push([t('sfNewFans'), fmt(r.newFans)]);
  if (r.ctr !== undefined) sf.push([t('sfCtr'), r.ctr + '%']);
  d.innerHTML = `<td colspan="12"><div class="d-detail">
      <div class="d-grid">
      ${[['视频ID', r.vid], ['账号', '@' + (r.account || '')], ['语种', r.lang || '—'], ['音乐', r.music || '—'],
        ['挂车', r.isEC ? '是' : '—'], ['广告', r.isAd ? '是' : '—'], ['AIGC', r.isAIGC ? '是' : '—'],
        ['发布时间', r.date + ' ' + r.time], ['时长', r.duration + 's'],
        ['播放/点赞/评论', fmt(r.views) + ' / ' + fmt(r.likes) + ' / ' + fmt(r.comments)],
        ['分享/收藏/转发', fmt(r.shares) + ' / ' + fmt(r.saves) + ' / ' + fmt(r.reposts)],
        ['互动率', pct2(r.inter)],
        ['链接', `<a href="${esc(r.url)}" target="_blank" rel="noopener" style="text-decoration:underline">${esc(t('colOpen'))}</a>`]]
        .map(([k, v]) => `<div><span class="dk">${esc(k)}</span><span class="dv">${/^https?:\/\//.test(String(v)) ? `<a href="${esc(v)}" target="_blank" rel="noopener" style="text-decoration:underline">${esc(t('colOpen'))}</a>` : esc(v)}</span></div>`).join('')}
      ${sf.map(([k, v]) => `<div><span class="dk">${esc(k)}</span><span class="dv">${esc(v)}</span></div>`).join('')}
      </div>
      ${withMedia ? `<!-- 播放器放在数据详情下方（用户要求），固定 16:9 小窗 -->
      <div class="d-player-wrap">
        <div class="d-player-box">
          <video class="d-video" controls playsinline preload="metadata" poster="${esc(r.cover || '')}" id="dvid-${esc(r.vid)}"></video>
        </div>
        <div class="d-player-note" id="dvnote-${esc(r.vid)}">${esc(t('playerLoading'))}</div>
      </div>
      <div class="d-actions">
        <button type="button" class="d-ai" data-vid="${esc(r.vid)}" style="${state.aiEnabled ? '' : 'display:none'}">${esc(t('aiOneVideo'))}</button>
        <button type="button" class="d-remake" data-vid="${esc(r.vid)}" style="${state.aiEnabled ? '' : 'display:none'}">${esc(t('aiRemakeBtn'))}</button>
      </div>` : ''}
      <div class="d-hist" id="dHist-${esc(r.vid)}">${esc(t('loading'))}…</div>
      <div class="d-out" id="dOut-${esc(r.vid)}"></div></div></td>`;
  return d;
}

/** 给已插入的详情行补播放器与历史趋势（异步、可延后） */
async function hydrateDetail(r, d, withMedia) {
  if (withMedia) {
    embedPlay(r, d);
    d.querySelectorAll('.d-ai, .d-remake').forEach((b) => {
      // 全部展开时按钮是延迟渲染的，模块状态可能已变，这里再校正一次显隐
      if (!state.aiEnabled) b.style.display = 'none';
    });
  }
  try {
    const el = d.querySelector('.d-hist');
    if (!el) return;
    await renderTrend(el, r);
  } catch (_) {
    const el = d.querySelector('.d-hist');
    if (el) el.textContent = '';
  }
}

function bindRowClick() {
  const tb = $('#rows');
  if (!tb || tb.dataset.bound) return;
  tb.dataset.bound = '1';
  tb.addEventListener('click', async (e) => {
    // 勾选 / 下载 / 详情内按钮不触发展开收起
    if (e.target.closest('.row-pick') || e.target.closest('.row-dl')) return;
    const tr = e.target.closest('tr');
    if (!tr || !tr.parentElement || tr.parentElement.id !== 'rows') return;
    // ⚠️ 点在**已展开的详情行内部**（AI 分析 / 生成复刻脚本 / 播放器…）时必须直接返回。
    //    否则 closest('tr') 命中的是 .d-tr 而不是数据行 → 会把刚展开的详情立刻收起，
    //    按钮随之消失，用户看到的就是「点了完全没反应」。
    if (tr.classList.contains('d-tr')) return;
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('d-tr')) { next.remove(); setExpandAll(false); return; }
    tb.querySelectorAll('.d-tr').forEach((x) => x.remove());
    setExpandAll(false);
    const vid = tr.dataset.vid;
    const r = currentRows().find((x) => String(x.vid) === String(vid));
    if (!r) return;
    const d = buildDetailRow(r, true);
    tr.after(d);
    await hydrateDetail(r, d, true);
  });
}

/** 同步「全部展开」按钮的文案与状态 */
function setExpandAll(on) {
  state.expandAll = !!on;
  const b = $('#expandAllBtn');
  if (!b) return;
  b.classList.toggle('on', state.expandAll);
  b.textContent = state.expandAll ? t('collapseAll') : t('expandAll');
}

/**
 * 表头「全部展开详情」：把当前**已渲染出来的**所有数据行各插入一条详情行。
 * withMedia=false —— 几十上百行各开一个 <video> 会把内存和流量打爆，
 * 批量展开只看数据，播放器仍需点单行才出。
 */
function initExpandAll() {
  const b = $('#expandAllBtn');
  if (!b) return;
  b.addEventListener('click', () => {
    const tb = $('#rows');
    if (!tb) return;
    if (state.expandAll) {
      tb.querySelectorAll('.d-tr').forEach((x) => x.remove());
      setExpandAll(false);
      return;
    }
    const trs = [...tb.querySelectorAll('tr[data-vid]')];
    trs.forEach((tr) => {
      if (tr.nextElementSibling && tr.nextElementSibling.classList.contains('d-tr')) return;
      const r = currentRows().find((x) => String(x.vid) === String(tr.dataset.vid));
      if (r) tr.after(buildDetailRow(r, false));
    });
    setExpandAll(true);
    // 趋势是逐行异步的，错开请求，别一次性打出去
    trs.forEach((tr, i) => {
      const d = tr.nextElementSibling;
      if (!d || !d.classList.contains('d-tr')) return;
      const r = currentRows().find((x) => String(x.vid) === String(tr.dataset.vid));
      if (r) setTimeout(() => hydrateDetail(r, d, false), i * 30);
    });
    toast(t('expandedN', { n: trs.length }), 'ok');
  });
}
initExpandAll();

/** 详情内嵌播放器：拿无水印直链 + 封面，塞进 <video> */
async function embedPlay(r, d) {
  const note = d.querySelector('.d-player-note');
  try {
    const res = await fetch('/api/video-download/play-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: r.url, vid: r.vid }),
    }).then((x) => x.json());
    if (res.error) throw new Error(res.error);
    const v = d.querySelector('video');
    v.src = res.playUrl;
    if (res.cover) v.poster = res.cover;
    note.textContent = `${res.duration || r.duration}s · ${t('playerNoWatermark')}`;
  } catch (e) {
    note.innerHTML = `<span class="tl-msg err">${esc(e.message)}</span>`;
  }
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
      /* 删除后仍显示条目 + 下载按钮（用户要求：删除不能让它从设置里消失） */
      const badge =
        state === 'on'
          ? `<span class="m-badge on">${esc(t('modEnabled'))}</span>`
          : state === 'off'
            ? `<span class="m-badge">${esc(t('modInstalled'))}</span>`
            : m.deleted
              ? `<span class="m-badge dim">${esc(t('modDeleted'))}</span>`
              : `<span class="m-badge dim">${esc(t('modAvailable'))}</span>`;
      const upd = m.updateAvailable ? `<span class="m-badge upd">${esc(t('modUpdate'))} v${esc(m.version)}</span>` : '';
      const actions = m.installed
        ? `<button type="button" data-act="toggle" data-id="${esc(m.id)}" data-to="${m.enabled ? '0' : '1'}">${m.enabled ? esc(t('modDisable')) : esc(t('modEnable'))}</button>
           ${m.updateAvailable ? `<button type="button" data-act="upgrade" data-id="${esc(m.id)}" class="primary">${esc(t('modUpgrade'))}</button>` : ''}
           <button type="button" data-act="del" data-id="${esc(m.id)}">${esc(t('modDelete'))}</button>`
        : `<button type="button" data-act="install" data-id="${esc(m.id)}" class="primary">${esc(t('modInstall'))}</button>`;
      const req = (m.requires || []).length ? `<div class="m-meta">${esc(t('modRequires'))} ${esc(m.requires.join(', '))}</div>` : '';
      const progress = m.installed ? '' : `<div class="m-progress" id="mp-${esc(m.id)}" style="display:none"></div>`;
      return `<div class="m-item">
        <div class="m-main">
          <div class="m-name">${esc(m.name)} <span class="m-ver">v${esc(m.installed ? m.installedVersion : m.version)}</span>${badge}${upd}</div>
          <div class="m-desc">${esc(m.description || '')}</div>
          ${req}${progress}
        </div>
        <div class="m-btns">${actions}</div>
      </div>`;
    })
    .join('');
}

/** 安装一个模块并实时展示「下载 → 校验 → 安装」三个阶段（完整模拟下载安装流程） */
async function installWithProgress(id) {
  const bar = document.getElementById('mp-' + id);
  if (bar) { bar.style.display = 'block'; bar.textContent = t('modStageDownload') + '… 0%'; }
  const poll = setInterval(async () => {
    try {
      const p = await fetch(`/api/modules/${id}/install-progress`, { cache: 'no-store' }).then((x) => x.json());
      if (!bar || !p) return;
      const label =
        p.stage === 'download' ? t('modStageDownload')
        : p.stage === 'verify' ? t('modStageVerify')
        : p.stage === 'install' ? t('modStageInstall')
        : p.stage;
      if (p.stage === 'error') {
        clearInterval(poll);
        bar.textContent = '✗ ' + (p.error || 'error');
        return;
      }
      if (p.stage !== 'done' && p.stage !== 'idle') bar.textContent = label + '… ' + (p.pct || 0) + '%';
    } catch (_) {}
  }, 400);
  try {
    const r = await fetch(`/api/modules/${id}/install`, { method: 'POST' }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    toast(`${t('modInstalledToast')} · ${t('modRestartHint')}`, 'ok');
  } catch (e) {
    if (bar) bar.textContent = '✗ ' + e.message;
    throw e;
  } finally {
    clearInterval(poll);
  }
}

$('#settingsModal').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const { act, id } = btn.dataset;
    btn.disabled = true;
    try {
      if (act === 'install') {
        await installWithProgress(id);
      } else if (act === 'upgrade') {
        // 升级 = 走同一条安装链路（安装器按 sha256 校验后原子替换），装完提示重启生效
        await installWithProgress(id);
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

/* ---------------- 应用更新（发布后由应用自己拉，不再手动装） ---------------- */
let lastUpdate = null;
function renderUpdate(d) {
  const el = $('#upState');
  const btn = $('#upInstall');
  if (!el) return;
  lastUpdate = d;
  if (!d) { el.textContent = ''; el.className = 'si-status'; return; }
  if (d.error) { el.textContent = t('upFailed', { err: d.error }); el.className = 'si-status err'; if (btn) btn.style.display = 'none'; return; }
  if (d.hasUpdate) { el.textContent = t('upAvailable', { v: d.latest, cur: d.current }); el.className = 'si-status ok'; }
  else { el.textContent = t('upUpToDate', { v: d.current }); el.className = 'si-status'; }
  if (btn) btn.style.display = d.hasUpdate && (d.setup || d.portable) ? '' : 'none';
}
$('#upCheck').addEventListener('click', async () => {
  const el = $('#upState');
  if (el) { el.textContent = t('upChecking'); el.className = 'si-status'; }
  try {
    renderUpdate(await fetch('/api/update/check?force=1', { cache: 'no-store' }).then((x) => x.json()));
  } catch (e) {
    renderUpdate({ error: e.message, current: '' });
  }
});
$('#upInstall').addEventListener('click', async () => {
  const el = $('#upState');
  const b = $('#upInstall');
  if (el) { el.textContent = t('upInstalling'); el.className = 'si-status'; }
  if (b) b.disabled = true;
  try {
    const r = await fetch('/api/update/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ install: !!lastUpdate && !lastUpdate.portable }),
    }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    if (el) { el.textContent = t('upInstalled'); el.className = 'si-status ok'; }
    toast(t('upInstalled'), 'ok');
  } catch (e) {
    if (el) { el.textContent = t('upFailed', { err: e.message }); el.className = 'si-status err'; }
  }
  if (b) b.disabled = false;
});

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
 * 模块前端：登录/工具入口只出现在**装了并启用**之后；
 * 卖家数据导入装好后主页出现「手动导入 / 自动导入」两个按钮；
 * AI 模块没装 → 所有 AI 入口隐藏。
 */
const LOGIN_MODULES = ['tiktok-login', 'seller-import'];
const LOGIN_LABEL = { 'tiktok-login': 'loginTiktok', 'seller-import': 'loginSeller' };

let MODS = [];
function modOn(id) {
  const m = MODS.find((x) => x.id === id);
  return !!(m && m.installed && m.enabled);
}

async function mountToolButtons() {
  let data;
  try {
    data = await fetch('/api/modules').then((x) => x.json());
  } catch (_) {
    return;
  }
  MODS = data.modules || [];
  const enabled = MODS.filter((m) => m.installed && m.enabled);
  state.aiEnabled = modOn('ai-analyst');
  initAiSettings(); // AI 模块装上/卸下 → 设置页的大模型配置组跟着显隐

  /* 登录组：只列「创作中心登录」+「卖家中心登录」两个入口。
     用户明确要求：设置里不要「XX数据导入」这种说法，登录就是登录。
     没装的不隐藏 —— 给一个「下载安装」按钮直接装。 */
  const loginHost = $('#loginActions');
  const toolHost = $('#toolActions');
  if (loginHost) {
    const list = LOGIN_MODULES.map((id) => MODS.find((m) => m.id === id)).filter(Boolean);
    loginHost.innerHTML = list.length
      ? list
          .map((m) =>
            m.installed && m.enabled
              ? `<button type="button" class="tool-open" data-id="${esc(m.id)}">${esc(t(LOGIN_LABEL[m.id] || m.id))}</button>`
              : `<button type="button" class="tool-open" data-act="install" data-id="${esc(m.id)}">${esc(t(LOGIN_LABEL[m.id] || m.id))} · ${esc(t('modInstall'))}</button>`
          )
          .join('')
      : `<div class="si-hint">${esc(t('modulesLoading'))}</div>`;
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

  // 卖家数据导入装好 → 主页出现「手动导入 / 自动导入」
  const sp = $('#sellerPanel');
  if (sp) sp.style.display = modOn('seller-import') ? 'block' : 'none';

  // AI 入口显隐刷新（当前有结果时按钮状态才可见）
  renderResults();
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
  // 登录：直接打开设置页的「登录」分组 —— 里面同时有创作中心与卖家中心两个登录入口
  // （用户要求小提示里只保留一个「去登录」，不再单列「卖家中心登录」）
  $('#tipLogin').addEventListener('click', () => {
    b.style.display = 'none';
    openSettings();
    const g = $('#loginActions');
    if (g) setTimeout(() => g.scrollIntoView({ block: 'center' }), 120);
  });
}

/* ================= 统一登录面板（创作中心 / 卖家中心 共用同一版式） =================
   用户明确要求：两个登录入口的 UI 必须一样、格式统一。
   所以版式只写这一份，两个模块各自传入自己的接口实现（spec.api / spec.start）。
   结构：账号选择 + 登录态徽标 → 登录方式 → 状态区 → QR/表单 → 操作行 → 提示 → 多账号管理折叠表。
   两边**列与按钮完全一致**（备注 / 账号 / 登录态 / 最近登录 / 操作；登录 · 切换 · 退出 · 删除），
   只有「添加账号」那一行按各自需要的字段渲染（spec.addFields）。 */
window.TTLoginUI = (() => {
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const jget = (u) => fetch(u, { cache: 'no-store' }).then((x) => x.json());
  const jpost = (u, b) =>
    fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then((x) =>
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
              await fetch(api.del(id), { method: 'DELETE' }).catch(() => {});
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
            await fetch(api.patch(b.dataset.site), {
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

/* ================= 登录弹窗（应用内小窗，承载登录类模块） ================= */
const LOGIN_MODULE_TITLE = { 'tiktok-login': 'loginTiktok', 'seller-import': 'loginSeller' };

async function openTool(moduleId) {
  const m = $('#loginModal');
  if (!m) return;
  // 入口守卫（用户反馈的 bug：没装模块时入口点了报「加载失败」）——
  // 没装/没启用就明确引导去设置下载，而不是报脚本加载错误
  const man = MODS.find((x) => x.id === moduleId);
  if (!man || !man.installed || !man.enabled) {
    toast(t('needModule'), 'err');
    openSettings();
    return;
  }
  // 登录类模块用登录语义的固定文案；其它工具类模块用模块自己的名字
  // （否则「开放平台数据」这类模块会被套上「登录」标题，用户不知道自己在哪）
  $('#loginTitle').textContent = LOGIN_MODULE_TITLE[moduleId]
    ? t(LOGIN_MODULE_TITLE[moduleId])
    : (man && man.name) || t('loginTitle');
  const body = $('#loginBody');
  body.innerHTML = `<div class="m-loading">${esc(t('loading'))}</div>`;
  m.style.display = 'flex';
  try {
    await loadScript(`/modules/${moduleId}/module.js`);
    const reg = window.TTModule.get(moduleId);
    if (!reg || typeof reg.mount !== 'function') throw new Error(t('moduleNoFrontend'));
    body.innerHTML = '';
    reg.mount(body, {
      t,
      loginOnly: true,
      // 登录成功后由这里统一触发「自动导入 + 抓取」，失败给重试入口
      onLoggedIn: () => autoSyncAfterLogin(moduleId),
    });
    // 兜底：模块自己没调 onLoggedIn（老版本模块）时，靠弹窗里的「已登录」状态类触发
    const mo = new MutationObserver(() => {
      const done = body.querySelector('[data-logged-in="1"],.si-logged-in');
      if (done && !body.dataset.syncFired) {
        body.dataset.syncFired = '1';
        mo.disconnect();
        autoSyncAfterLogin(moduleId);
      }
    });
    mo.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-logged-in'] });
  } catch (e) {
    body.innerHTML = `<div class="si-status err">${esc(e.message)}</div>`;
  }
}

function closeTool() {
  const m = $('#loginModal');
  if (m) m.style.display = 'none';
  $('#loginBody').innerHTML = '';
}

/**
 * 登录成功后自动导入 + 抓取（用户要求：登录了就该自动拿数据，失败要能重试）。
 * 失败时不只是弹个 toast —— 额外给一个「重试」按钮点一下就能再试。
 */
async function autoSyncAfterLogin(moduleId) {
  const endpoint =
    moduleId === 'seller-import' ? '/api/seller-import/login-sync' : '/api/tiktok-login/sync-now';
  const host = $('#loginBody');
  const badge = document.createElement('div');
  badge.className = 'si-hint sync-badge';
  badge.textContent = t('syncAfterLogin');
  if (host) host.appendChild(badge);

  const run = async () => {
    badge.textContent = t('syncAfterLogin');
    const old = badge.querySelector('.retry');
    if (old) old.remove();
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).then((x) => x.json());
      if (r.error || r.ok === false) throw new Error(r.error || t('noData'));
      const n = r.n != null ? r.n : r.matched;
      badge.textContent = t('syncOkN', { n: n || 0 });
      // 数据变了 → 重新拉一次当前任务，让明细表立刻反映出来
      if (state.jobId) refreshRowsFromJob();
      toast(t('syncOkN', { n: n || 0 }), 'ok');
    } catch (e) {
      badge.innerHTML = `<span class="err">${esc(t('syncFailed', { err: e.message }))}</span> `;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-like retry';
      b.textContent = t('retrySync');
      b.addEventListener('click', run);
      badge.appendChild(b);
    }
  };
  run();
}

/**
 * 创作中心 · 账号趋势。
 * 数据来源：TikTok 创作中心的 /aweme/v2/data/insight/（登录创作中心后自动抓）。
 * ⚠️ 这是**账号级日度序列**，也是全应用唯一真正的「趋势」数据源 ——
 *    TikTok 抓取只能给「今天这一刻的快照」，同一天抓十次也画不出趋势。
 *    逐条视频那边创作中心并没有独有指标（实测只有 play/like/comment/share/favorite），
 *    所以不要把两件事混在一起讲。
 */
const CR_METRICS = [
  { key: 'vv_history', label: 'colViews' },
  { key: 'like_history', label: 'colLikes' },
  { key: 'comment_history', label: 'colComments' },
  { key: 'share_history', label: 'colShares' },
  { key: 'follower_num_history', label: 'followers' },
  { key: 'net_follower_history', label: 'crNetFans' },
  { key: 'video_finish_rate_history_7d', label: 'sfFinish', pct: true },
  { key: 'reached_audience_history', label: 'crReach' },
  { key: 'pv_history', label: 'crProfileViews' },
];

/** 创作中心返回的流量来源是英文枚举，翻成当前语言（没收录的原样显示） */
const CR_TRAFFIC_LABEL = {
  Search: 'crSrcSearch',
  'Personal Profile': 'crSrcProfile',
  Follow: 'crSrcFollow',
  'For You': 'crSrcForYou',
  Sound: 'crSrcSound',
};
function crTrafficLabel(k) {
  const key = CR_TRAFFIC_LABEL[k];
  return key ? t(key) : k;
}

async function renderCreatorTrend() {
  const host = $('#crPanel');
  if (!host) return;
  let d = null;
  try {
    d = await fetch('/api/tiktok-login/insight', { cache: 'no-store' }).then((x) => x.json());
  } catch (_) {}
  const series = (d && d.series) || {};
  const keys = Object.keys(series);
  if (!d || !d.ok || !keys.length) {
    // 没登录创作中心就不展示这一块，避免给用户一个空壳
    host.style.display = 'none';
    return;
  }

  const items = CR_METRICS.filter((m) => Array.isArray(series[m.key]) && series[m.key].length >= 2).map((m) => {
    let vals = series[m.key].slice();
    // 完播率可能是 0~1 的小数，统一成百分数展示
    if (m.pct && Math.max.apply(null, vals) <= 1) vals = vals.map((v) => v * 100);
    return Object.assign({}, m, { pts: vals.map((v, i) => ({ d: String(i + 1), v })), vals });
  });

  const meta = d.meta || {};
  const upd = d.at ? new Date(d.at).toISOString().slice(0, 16).replace('T', ' ') : '';

  const body = items.length
    ? items
        .map((m) => {
          const a = m.vals[0];
          const b = m.vals[m.vals.length - 1];
          const fmtV = (x) => (m.pct ? x.toFixed(1) + '%' : fmt(x));
          const delta = a ? ((b - a) / a) * 100 : 0;
          return `<div class="trend-item">
            <div class="trend-legend"><b>${esc(t(m.label))}</b><span class="lg-src">${esc(t('trendSrcCreator'))}</span>
              ${esc(fmtV(a))} → ${esc(fmtV(b))}
              <span class="${delta >= 0 ? 'up' : 'down'}">(${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)</span>
            </div>
            <div class="trend-chart">${trendLine(m.pts)}</div>
          </div>`;
        })
        .join('')
    : `<div class="trend-empty">${esc(t('crNoSeries'))}</div>`;

  const traffic = Array.isArray(meta.traffic)
    ? meta.traffic.map((x) => ({ k: x.key, n: Number(x.pct) || 0 })).slice(0, 6)
    : [];
  const searchTerms = Array.isArray(meta.searchTerms) ? meta.searchTerms.slice(0, 6) : [];

  const foot = [];
  if (meta.followers) foot.push(`${t('followers')} ${fmt(meta.followers)}`);
  if (meta.uniqueViewer) foot.push(`${t('crUniqueViewer')} ${fmt(meta.uniqueViewer)}`);
  if (d.handle) foot.push(`@${esc(d.handle)}`);

  host.style.display = 'block';
  host.innerHTML = `
    <h2 class="sec-title">${esc(t('crTitle'))}
      <span class="hint">${esc(t('trendSrcCreator'))}${upd ? ' · ' + esc(t('crUpdated', { t: upd })) : ''}</span>
      <button type="button" id="crRefresh" class="btn-like sm">${esc(t('crRefresh'))}</button>
    </h2>
    <div class="trend-box">
      ${foot.length ? `<div class="trend-head"><span class="trend-src">${foot.join(' · ')}</span></div>` : ''}
      ${body}
      ${
        traffic.length
          ? `<div class="trend-src" style="margin-top:10px"><b>${esc(t('crTraffic'))}</b>：${traffic
              .map((x) => `${esc(crTrafficLabel(x.k))} ${x.n.toFixed(1)}%`)
              .join(' · ')}</div>`
          : ''
      }
      ${
        searchTerms.length
          ? `<div class="trend-src" style="margin-top:4px"><b>${esc(t('crSearch'))}</b>：${searchTerms
              .map((x) => esc(String(x)))
              .join(' · ')}</div>`
          : ''
      }
    </div>`;

  const btn = $('#crRefresh');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = t('crFetching');
      try {
        const r = await fetch('/api/tiktok-login/sync-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).then((x) => x.json());
        if (r.error || r.ok === false) throw new Error(r.error || t('noData'));
        toast(t('syncOkN', { n: r.n || 0 }), 'ok');
      } catch (e) {
        toast(t('syncFailed', { err: e.message }), 'err');
      }
      btn.disabled = false;
      renderCreatorTrend();
    });
  }
}

/** 重新拉当前任务的行（平台数据同步后要让明细立刻变化） */
async function refreshRowsFromJob() {
  if (!state.jobId) return;
  try {
    const r = await fetch(`/api/jobs/${state.jobId}/sync`, { method: 'POST' }).then((x) => x.json());
    if (r.rows && r.rows.length) {
      state.rows = r.rows;
      if (r.summary) state.summary = r.summary;
      renderResults();
    }
  } catch (_) {}
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
  showLoader('download', t('loadDownloadOne'));
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
    pollDlJob(res.jobId, (job) => {
      const ok = (job.files || []).length;
      const bad = (job.errors || []).length;
      toast(t('dlFinished', { ok, bad }) + (bad ? ' · ' + job.errors[0] : ''), ok ? 'ok' : 'err');
    }, 1);
  } catch (e) {
    hideLoader();
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
  if (ai) {
    // stopPropagation 必须在 document 阶段之前生效，所以这里靠 bindRowClick 里的
    // `.d-tr` 早退来隔离（document 阶段的 stopPropagation 拦不住已经跑过的 tbody 监听器）。
    e.stopPropagation();
    aiOneVideo(ai.dataset.vid, document.getElementById('dOut-' + ai.dataset.vid));
    return;
  }
  const rm = e.target.closest('.d-remake');
  if (rm) {
    e.stopPropagation();
    remakeVideo(rm.dataset.vid, document.getElementById('dOut-' + rm.dataset.vid));
    return;
  }
});

/* ================= 挂车对比（按钮 → 小弹窗，不常驻主页） ================= */
function initEcCompare() {
  const b = $('#ecCompareBtn');
  const m = $('#ecModal');
  if (!b || !m) return;
  b.addEventListener('click', () => {
    if (!currentJobId()) return toast(t('siNeedJob'), 'err');
    // 真正的挂车对比表（旧版这里错开成了登录模块 —— 已修）
    if (!renderEc(currentRows())) return toast(t('noData'), 'err');
    m.style.display = 'flex';
  });
  $('#ecClose').addEventListener('click', () => (m.style.display = 'none'));
  m.addEventListener('click', (e) => { if (e.target === m) m.style.display = 'none'; });
}

/* AI 时期分析按钮已删（Round 11）：分析默认自动生成在概览的「AI 经营简报」里，不再需要点击 */
initEcCompare();

/* ================= 行勾选（全选 / 单选，配合批量下载） ================= */
function bindRowPicks() {
  const rows = currentRows();
  const all = $('#rowSelAll');
  if (all) {
    all.checked = rows.length > 0 && rows.every((r) => state.picked.has(String(r.vid)));
    all.onchange = () => {
      if (all.checked) rows.forEach((r) => state.picked.add(String(r.vid)));
      else rows.forEach((r) => state.picked.delete(String(r.vid)));
      updatePickCount();
      renderResults();
    };
  }
  document.querySelectorAll('.row-pick').forEach((c) => {
    c.addEventListener('click', (e) => e.stopPropagation()); // 别触发行点击（详情）
    c.addEventListener('change', () => {
      const v = String(c.dataset.vid);
      if (c.checked) state.picked.add(v); else state.picked.delete(v);
      updatePickCount();
      renderResults();
    });
  });
}

/* ================= 下载任务轮询（共用，兼作下载进度动画） ================= */
function pollDlJob(jobId, onDone, total) {
  let ticked = 0;
  const poll = setInterval(async () => {
    const job = await fetch(`/api/video-download/jobs/${jobId}`).then((x) => x.json()).catch(() => null);
    if (!job) return;
    ticked++;
    // 没给总数时给一个缓慢爬升的假进度，避免看着像卡死
    const done = (job.files || []).length + (job.errors || []).length;
    const pct = total ? (done / total) * 100 : Math.min(92, ticked * 6);
    setLoaderProgress(pct, t('loadDownloadN', { n: done, total: total || '?' }));
    if (job.status === 'done' || job.status === 'error') {
      clearInterval(poll);
      hideLoader();
      onDone(job);
    }
  }, 1500);
}

/* 主页卡片 ⤓：按当前期次日期范围下载该账号主页视频 */
async function downloadHandleVideos(handle) {
  const h = String(handle || '').replace(/^@/, '');
  if (!h) return;
  toast(t('dlResolving'), 'ok');
  try {
    const rg = state.ranges || {};
    const rs = await fetch('/api/video-download/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'handle', input: h, from: rg.currentFrom, to: rg.currentTo }),
    }).then((x) => x.json());
    if (rs.error) throw new Error(rs.error);
    if (!rs.items || !rs.items.length) throw new Error(t('noData'));
    const res = await fetch('/api/video-download/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: rs.items, quality: 'best' }),
    }).then((x) => x.json());
    if (res.error) throw new Error(res.error);
    pollDlJob(res.jobId, (job) => {
      const ok = (job.files || []).length;
      const bad = (job.errors || []).length;
      toast(t('dlFinished', { ok, bad }) + (bad ? ' · ' + job.errors[0] : ''), ok ? 'ok' : 'err');
    }, (rs.items || []).length);
  } catch (e) {
    hideLoader();
    toast(e.message, 'err');
  }
}

/* ================= 批量下载：点「批量下载」才进入待选中态 =================
   用户要求：选中状态不要常驻。默认列表没有勾选框；点批量下载 → 出现勾选列 +
   取消/下载两个按钮；取消恢复常态，下载执行选中项。 */
function setPicking(on) {
  state.picking = !!on;
  if (!on) state.picked.clear();
  document.body.classList.toggle('picking', state.picking);
  const bar = $('#pickBar');
  if (bar) bar.style.display = state.picking ? 'inline-flex' : 'none';
  renderResults();
  updatePickCount();
}
function updatePickCount() {
  const n = $('#pickCount');
  if (n) n.textContent = state.picked.size ? t('dlPicked', { n: state.picked.size }) : t('dlPick');
}

function initBatchDl() {
  const b = $('#dlBatchBtn');
  if (b) {
    b.addEventListener('click', () => {
      if (state.picking) setPicking(false);
      else setPicking(true);
    });
  }
  const cancel = $('#dlPickCancel');
  if (cancel) cancel.addEventListener('click', () => setPicking(false));

  const go = $('#dlPickGo');
  if (go) {
    go.addEventListener('click', async () => {
      const vids = [...state.picked];
      if (!vids.length) return toast(t('dlPick'), 'err');
      const rows = currentRows().filter((r) => state.picked.has(String(r.vid)));
      toast(t('dlResolving'), 'ok');
      try {
        const res = await fetch('/api/video-download/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: rows.map((r) => ({ vid: r.vid, url: r.url, desc: r.desc, account: r.account, playUrl: r.playUrl })), quality: 'best' }),
        }).then((x) => x.json());
        if (res.error) throw new Error(res.error);
        pollDlJob(res.jobId, (job) => {
          const ok = (job.files || []).length;
          const bad = (job.errors || []).length;
          toast(t('dlFinished', { ok, bad }) + (bad ? ' · ' + job.errors[0] : ''), ok ? 'ok' : 'err');
        }, rows.length);
        setPicking(false);
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  }
}
initBatchDl();

/**
 * 搜索框里粘贴链接/vid → 回车 → 解析并**直接进入视频明细表**。
 * 用户要求：解析结果和抓取结果在同一张表里看、能逐条下载、也能批量下载。
 * 解析接口不返回播放量等指标，所以这些列显示「—」（未知），不伪造数字。
 */
async function resolveRefsIntoRows(refs) {
  const st = $('#searchHint');
  if (st) st.textContent = t('dlResolving');
  showLoader('resolve', t('loadResolveN', { n: refs.length }));
  try {
    const rs = await fetch('/api/video-download/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'urls', input: refs.join(' ') }),
    }).then((x) => x.json());
    if (rs.error) throw new Error(rs.error);
    const items = rs.items || [];
    if (!items.length) throw new Error((rs.errors || []).join('; ') || t('noData'));

    const known = new Set(state.rows.map((r) => String(r.vid)));
    const fresh = items
      .filter((it) => it.vid && !known.has(String(it.vid)))
      .map((it) => {
        const ts = Number(it.createTime || 0) * 1000;
        const d = ts ? new Date(ts + 7 * 3600 * 1000).toISOString() : '';
        return {
          vid: String(it.vid),
          account: it.author || it.account || 'link',
          date: d ? d.slice(0, 10) : '',
          time: d ? d.slice(11, 16) : '',
          desc: it.desc || '',
          views: null, likes: null, comments: null, shares: null, saves: null, reposts: null,
          inter: null,
          duration: it.duration || 0,
          isEC: false,
          url: it.url || '',
          cover: it.cover || '',
          playUrl: it.playUrl || '',
          fromLink: true,
        };
      });
    if (!fresh.length) throw new Error(t('dlAlreadyThere'));
    state.rows = fresh.concat(state.rows);
    state.tab = '__all__';
    state.search = '';
    state.searchRefs = null;
    const input = $('#search');
    if (input) input.value = '';
    if (st) st.style.display = 'none';
    $('#dlResolveBtn2').classList.remove('on');
    renderResults();
    toast(t('dlAddedRows', { n: fresh.length }), 'ok');
  } catch (e) {
    if (st) {
      st.textContent = e.message;
      st.style.display = 'block';
    }
    toast(e.message, 'err');
  } finally {
    hideLoader();
  }
}

/* ================= 搜索框：粘贴链接/vid → 回车或点 ⤓ → 解析后进视频明细 ================= */
function initSearchResolve() {
  const btn = $('#dlResolveBtn2');
  if (!btn) return;
  btn.title = t('searchLinkGo');
  btn.addEventListener('click', () => {
    const raw = $('#search').value.trim();
    const refs = state.searchRefs && state.searchRefs.length ? state.searchRefs : parseSearchRefs(raw);
    if (!refs.length) return toast(t('searchNeedLink'), 'err');
    resolveRefsIntoRows(refs);
  });
}
initSearchResolve();

/* ================= 主页卖家数据导入（只保留手动上传；自动导入在登录/抓取时自动做） ================= */
function initSellerPanel() {
  const manual = $('#sellerManualBtn');
  const modal = $('#sellerModal');
  if (!manual) return;
  manual.addEventListener('click', () => {
    if (!modal) return;
    $('#sellerStatus').textContent = '';
    $('#sellerFile').value = '';
    modal.style.display = 'flex';
  });
  if (modal) {
    $('#sellerClose').addEventListener('click', () => (modal.style.display = 'none'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
  }
  const file = $('#sellerFile');
  if (file) {
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      const st = $('#sellerStatus');
      if (!f) return;
      st.className = 'si-status';
      st.textContent = t('sellerUploading');
      try {
        const buf = await f.arrayBuffer();
        const r = await fetch('/api/seller-import/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        st.className = 'si-status ok';
        st.textContent = t('sellerImported', { n: r.count, range: r.dateRange || '' });
        renderResults(); // 新导入的商家指标会经同步框架合并进当前结果
      } catch (e) {
        st.className = 'si-status err';
        st.textContent = e.message;
      }
    });
  }
}
initSellerPanel();

/* ================= 设置页：大模型接口配置（仅装了 AI 模块时显示） ================= */
async function initAiSettings() {
  const g = $('#aiGroup');
  if (!g) return;
  // AI 模块没装 → 整组隐藏（不出现任何 AI 入口）
  g.style.display = modOn('ai-analyst') ? 'block' : 'none';
  if (!modOn('ai-analyst')) return;
  try {
    const d = await fetch('/api/settings/llm', { cache: 'no-store' }).then((x) => x.json());
    $('#aiBase').value = d.base || '';
    $('#aiModel').value = d.model || 'auto-ops';
    $('#aiVision').value = d.vision || '';
    const keyEl = $('#aiKey');
    keyEl.value = '';
    keyEl.placeholder = d.hasKey ? t('aiKeySet') + ' · ' + (d.keyHint || '') : t('aiKey');
  } catch (_) {}
  $('#aiSave').addEventListener('click', async () => {
    try {
      const body = {
        base: $('#aiBase').value.trim(),
        model: $('#aiModel').value.trim() || 'auto-ops',
        vision: $('#aiVision').value.trim(),
      };
      const k = $('#aiKey').value.trim();
      if (k) body.key = k; // 不填 = 保持原密钥
      const r = await fetch('/api/settings/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      toast(t('aiSaved'), 'ok');
      initAiSettings(); // 重新加载占位提示
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  $('#aiTest').addEventListener('click', async () => {
    const st = $('#aiStatus');
    st.className = 'si-status';
    st.textContent = t('aiTest') + '…';
    const t0 = Date.now();
    try {
      const r = await fetch('/api/settings/llm/test', { method: 'POST' }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      st.className = 'si-status ok';
      st.textContent = t('aiTestOk', { ms: r.ms });
    } catch (e) {
      st.className = 'si-status err';
      st.textContent = e.message;
    }
  });
}

/* ================= 自定义应用框（无边框窗口控制，仅 Electron 下显示） ================= */
function initTitlebar() {
  const tb = $('#titlebar');
  if (!tb) return;
  const win = window.TTWin;
  if (!win || typeof win.minimize !== 'function') return; // 浏览器环境不显示
  tb.style.display = 'flex';
  document.body.classList.add('has-titlebar');
  $('#tbMin').addEventListener('click', () => win.minimize());
  $('#tbMax').addEventListener('click', () => (typeof win.toggleMax === 'function' ? win.toggleMax() : win.maximize()));
  $('#tbClose').addEventListener('click', () => win.close());
}



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

/* ================= 存储位置（默认路径 + 用户可手动修改下载目录） ================= */
/**
 * 用户要求：提供默认路径，但必须能在设置里手动改成任意文件夹。
 * 后端负责校验（拒磁盘根目录、探针写测试），这里只做读写与提示。
 */
async function initStorage() {
  const input = $('#storageDir');
  const pick = $('#storagePick');
  if (!input) return;
  const load = async () => {
    try {
      const d = await fetch('/api/settings/storage', { cache: 'no-store' }).then((x) => x.json());
      input.value = d.custom ? d.downloadDir : '';
      const shown = d.custom ? d.downloadDir : t('storageDefault');
      if (pick) pick.textContent = shown + (d.custom ? '' : ` · ${d.downloadDir}`);
    } catch (_) {}
  };
  await load();

  /* 点路径框 → 弹系统文件夹选择器（也可直接输入后回车保存） */
  const saveDir = async (dir) => {
    const r = await fetch('/api/settings/storage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadDir: dir }),
    }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    toast(t('storageSaved'), 'ok');
    await load();
  };
  if (pick) {
    pick.addEventListener('click', async () => {
      try {
        const r = await fetch('/api/settings/storage/pick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: input.value }),
        }).then((x) => x.json());
        if (r.canceled) return;
        if (!r.ok) {
          // 浏览器直开模式没有原生对话框 → 退回可输入的文本框
          input.style.display = '';
          input.focus();
          input.select();
          return toast(t('storageInputHint'), 'err');
        }
        await saveDir(r.dir);
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveDir(input.value.trim()).catch((err) => toast(err.message, 'err'));
    }
  });
  const save = $('#storageSave');
  if (save) {
    save.addEventListener('click', async () => {
      try {
        await saveDir(input.value.trim());
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  }
  const reset = $('#storageReset');
  if (reset) {
    reset.addEventListener('click', async () => {
      input.value = '';
      input.style.display = 'none';
      try {
        await saveDir('');
        toast(t('storageResetDone'), 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  }
  const openBtn = $('#storageOpen');
  if (openBtn) {
    openBtn.addEventListener('click', async () => {
      try {
        const r = await fetch('/api/settings/storage/open', { method: 'POST' }).then((x) => x.json());
        if (r && r.error) toast(r.error, 'err');
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  }
}

initPlayer();
initStorage();
initAiSettings();
initTitlebar();


/* 版本标识：确认当前跑的是哪一版（避免「更新没生效」的困惑） */
async function showAppVer() {
  const el = document.getElementById('appVer');
  if (!el) return;
  try {
    const h = await fetch('/api/health', { cache: 'no-store' }).then((x) => x.json());
    el.textContent = `v${h.version || '?'} · ${h.build || ''}`;
  } catch (_) {}
}
showAppVer();

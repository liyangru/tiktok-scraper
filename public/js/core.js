/* ============================================================
   核心工具：DOM / 格式化 / 请求 / Toast / 全局状态
   其它脚本都依赖这里，必须最先加载（index.html 里的顺序）。
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* 界面既可由本地 http 提供（浏览器/开发），也可由 Electron 以 file:// 加载。
   后者需要一个绝对 API 基址，通过 ?api=http://127.0.0.1:PORT 传入；前者留空走相对路径。 */
const API = (new URLSearchParams(location.search).get('api') || '').replace(/\/$/, '');

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- 数字格式 ----------------
   null / undefined = 没有数据 → 「—」；0 是真实的 0，照常显示。 */
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const DASH = '—';

function fmtInt(n) {
  return isNum(n) ? Math.round(n).toLocaleString('en-US') : DASH;
}
function fmtDec(n, d = 1) {
  return isNum(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : DASH;
}
function fmtPct(n, d = 2) {
  return isNum(n) ? (n * 100).toFixed(d) + '%' : DASH;
}
/** 紧凑写法（坐标轴、摘要用）：中文用 万 / 亿，其它语言用 K / M */
function fmtCompact(n) {
  if (!isNum(n)) return DASH;
  const a = Math.abs(n);
  const zh = window.currentLang === 'zh';
  const trim = (x) => String(+x.toFixed(x >= 100 ? 0 : 1));
  if (zh) {
    if (a >= 1e8) return trim(n / 1e8) + '亿';
    if (a >= 1e4) return trim(n / 1e4) + '万';
  } else {
    if (a >= 1e6) return trim(n / 1e6) + 'M';
    if (a >= 1e3) return trim(n / 1e3) + 'K';
  }
  return a < 10 && a % 1 ? n.toFixed(1) : String(Math.round(n));
}
/** 按指标类型格式化：int / dec / pct */
function fmtKind(n, kind) {
  if (kind === 'pct') return fmtPct(n);
  if (kind === 'dec') return fmtDec(n, 1);
  return fmtInt(n);
}
/** 带符号的差值；比率类的差值单位是「百分点」 */
function fmtSigned(n, kind) {
  if (!isNum(n)) return DASH;
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (kind === 'pct') return sign + (a * 100).toFixed(2) + ' ' + t('pp');
  if (kind === 'dec') return sign + fmtDec(a, 1);
  return sign + fmtInt(a);
}

/**
 * 变化标记：▲ 绿 / ▼ 红 / 持平 灰；没有可比基数时显示「—」并给出原因。
 * 颜色之外还有箭头和正负号，色弱用户也不会读错。
 */
function deltaChip(pct, opts = {}) {
  if (!isNum(pct)) {
    return `<span class="delta na" title="${esc(opts.naTitle || t('deltaNa'))}">${DASH}</span>`;
  }
  const flat = Math.abs(pct) < 0.0005;
  const cls = flat ? 'flat' : pct > 0 ? 'up' : 'down';
  const arrow = flat ? '' : pct > 0 ? '▲' : '▼';
  const txt = `${arrow}${flat ? '0.0' : (Math.abs(pct) * 100).toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`;
  return `<span class="delta ${cls}"${opts.title ? ` title="${esc(opts.title)}"` : ''}>${txt}</span>`;
}

/** 秒 → mm:ss / h:mm:ss */
function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}
/** YYYY-MM-DD → MM-DD（同一年内的短写法） */
const shortDate = (d) => (d ? String(d).slice(5) : '');
/** 区间 → 「11-01 ~ 11-17」；跨年时带年份 */
function rangeText(from, to) {
  if (!from || !to) return DASH;
  const sameYear = from.slice(0, 4) === to.slice(0, 4) && from.slice(0, 4) === TTPeriod.today().slice(0, 4);
  return sameYear ? `${shortDate(from)} ~ ${shortDate(to)}` : `${from} ~ ${to}`;
}

/* ---------------- 请求 ----------------
   统一处理：非 2xx / 非 JSON / 网络错误 → 抛出带可读信息的 Error，
   调用方只需 catch 后显示 e.message，不会出现「请求失败」这种无信息报错。 */
async function api(path, opts = {}) {
  const init = { cache: 'no-store', ...opts };
  if (opts.body !== undefined && typeof opts.body !== 'string' && !(opts.body instanceof ArrayBuffer)) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  }
  let res;
  try {
    res = await fetch(API + path, init);
  } catch (e) {
    const err = new Error(t('errNetwork'));
    err.network = true;
    throw err;
  }
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok || (data && data.error && data.ok !== true)) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
const jget = (p) => api(p);
const jpost = (p, body) => api(p, { method: 'POST', body: body === undefined ? {} : body });

/* ---------------- 按钮内 Loading ----------------
   小操作只在按钮上转圈，不盖整个页面。返回 done() 用来恢复。 */
function btnBusy(btn, label) {
  if (!btn) return () => {};
  const old = btn.innerHTML;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.setAttribute('aria-busy', 'true');
  btn.innerHTML = `<span class="spinner sm" aria-hidden="true"></span><span>${esc(label || btn.textContent)}</span>`;
  return () => {
    btn.innerHTML = old;
    btn.disabled = wasDisabled;
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
  };
}

/* ---------------- Toast ---------------- */
function toast(msg, kind) {
  const host = $('#toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.classList.add('out'), kind === 'err' ? 5200 : 3200);
  setTimeout(() => el.remove(), kind === 'err' ? 5600 : 3600);
}

/* ---------------- 本地偏好（读写失败不影响使用） ---------------- */
const prefs = {
  get(k, def) {
    try {
      const v = localStorage.getItem('tt.' + k);
      return v === null ? def : JSON.parse(v);
    } catch (_) {
      return def;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('tt.' + k, JSON.stringify(v));
    } catch (_) {}
  },
};

/* ---------------- 弹窗 ---------------- */
function openModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.hidden = false;
  m.classList.add('open');
  const focusable = m.querySelector('[autofocus], .modal-close');
  if (focusable) setTimeout(() => focusable.focus(), 30);
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.remove('open');
  m.hidden = true;
  if (typeof m._onClose === 'function') m._onClose();
}
/** 所有 .modal-backdrop：点遮罩 / × / Esc 关闭 */
function initModals() {
  $$('.modal-backdrop').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) closeModal(m.id);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = $$('.modal-backdrop.open');
    if (open.length) closeModal(open[open.length - 1].id);
  });
}

/* ---------------- 全局状态 ---------------- */
const state = {
  jobId: null,
  task: null, // 正在跑 / 刚结束的抓取任务（进度面板用）
  job: null, // 当前查看结果的任务（GET /api/jobs/:id 的结果，含明细）
  rows: [], // 全部行（本期 ∪ 对比期，含搜索框解析进来的链接行）
  view: null, // 当前展示的期次 { currentFrom, currentTo, compareFrom, compareTo, mode, info }
  account: '__all__',
  busy: false,
  aiConfigured: false,
};

/* ============================================================
   数据筛选：起止日期 / 快捷日期 / 对比方式

   日期框交互：
   - 整个日期框（文字、空白处、日历图标）都可以打开日期选择器：
     原生日历按钮被拉伸覆盖整个输入框（CSS），再加上容器点击时调用 showPicker() 兜底；
   - 键盘：Tab 聚焦后可直接键入日期，Enter / 空格 / Alt+↓ 打开选择器；
   - 选完立即规整（倒置、超出今天、非法日期）并在下方给出反馈，对比区间同步重算。
   所有日期运算都走 TTPeriod（曼谷日历，不经过本机时区）。
   ============================================================ */
const TTFilter = (() => {
  const listeners = [];
  const f = {
    from: '',
    to: '',
    preset: 'thisMonth',
    mode: 'none',
    cmpFrom: '',
    cmpTo: '',
  };

  const PRESET_KEYS = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'last7', 'last30', 'last90', 'all', 'custom'];
  const MODE_KEYS = ['none', 'previous', 'lastWeek', 'lastMonth', 'custom'];

  function today() {
    return TTPeriod.today();
  }

  /** 当前筛选对应的对比区间（与服务端同一份算法） */
  function compare() {
    if (f.mode === 'none') return null;
    return TTPeriod.compareRange(f.mode, f.from, f.to, { from: f.cmpFrom, to: f.cmpTo });
  }

  function snapshot() {
    return { ...f, compare: compare(), isAll: TTPeriod.isAll(f.from) };
  }

  function emit(reason) {
    prefs.set('filter', { preset: f.preset, from: f.from, to: f.to, mode: f.mode, cmpFrom: f.cmpFrom, cmpTo: f.cmpTo });
    render();
    const snap = snapshot();
    listeners.forEach((fn) => {
      try {
        fn(snap, reason);
      } catch (e) {
        console.error(e);
      }
    });
  }

  /* ---------------- 渲染 ---------------- */
  function renderPresets() {
    const host = $('#presetSeg');
    if (!host) return;
    host.innerHTML = PRESET_KEYS.map(
      (k) =>
        `<button type="button" role="radio" data-preset="${k}" aria-checked="${f.preset === k}" class="${f.preset === k ? 'on' : ''}">${esc(t('preset_' + k))}</button>`
    ).join('');
  }

  function renderModes() {
    const sel = $('#cmpMode');
    if (!sel) return;
    sel.innerHTML = MODE_KEYS.map((k) => `<option value="${k}"${f.mode === k ? ' selected' : ''}>${esc(t('cmpMode_' + k))}</option>`).join('');
    sel.disabled = TTPeriod.isAll(f.from);
  }

  function render() {
    $('#from').value = f.from;
    $('#to').value = f.to;
    const max = today();
    ['#from', '#to', '#cmpFrom', '#cmpTo'].forEach((s) => {
      const el = $(s);
      if (el) {
        el.max = max;
        el.min = TTPeriod.ALL_FROM;
      }
    });
    $$('#presetSeg [data-preset]').forEach((b) => {
      const on = b.dataset.preset === f.preset;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });

    // 本期反馈
    const days = TTPeriod.span(f.from, f.to);
    const note = $('#rangeNote');
    if (note) {
      note.innerHTML = TTPeriod.isAll(f.from)
        ? `<b>${esc(t('preset_all'))}</b> ${esc(t('rangeAllNote', { to: f.to }))}`
        : `<b>${esc(rangeText(f.from, f.to))}</b> ${esc(t('nDays', { n: days }))}`;
    }

    // 对比
    const sel = $('#cmpMode');
    if (sel) {
      sel.value = f.mode;
      sel.disabled = TTPeriod.isAll(f.from);
    }
    const custom = $('#cmpCustom');
    if (custom) custom.hidden = f.mode !== 'custom';
    if ($('#cmpFrom')) $('#cmpFrom').value = f.cmpFrom || '';
    if ($('#cmpTo')) $('#cmpTo').value = f.cmpTo || '';

    // 对比期：只显示区间与天数；平移 / 重叠 / 月末对齐等口径说明收进 ⓘ
    const c = compare();
    const cnote = $('#cmpNote');
    if (cnote) {
      const warns = [];
      const infos = [];
      if (c) {
        if (c.shiftedWeek) warns.push(t('warnShiftedWeek', { n: c.currentDays }));
        if (c.overlapDays) warns.push(t('warnOverlap', { n: c.overlapDays }));
        if (c.clamped) infos.push(t('warnClamped'));
        if (c.fullMonth) infos.push(t('noteFullMonth'));
        if (!c.sameSpan && !c.fullMonth) infos.push(t('warnSpan', { a: c.currentDays, b: c.days }));
      }
      if (TTPeriod.isAll(f.from)) cnote.innerHTML = esc(t('cmpAllNa'));
      else if (f.mode === 'none') cnote.innerHTML = '';
      else if (!c) cnote.innerHTML = `<span class="err">${esc(t('cmpCustomNeed'))}</span>`;
      else
        cnote.innerHTML =
          `<b>${esc(rangeText(c.from, c.to))}</b> ${esc(t('nDays', { n: c.days }))}` +
          (c.overlapDays ? ` <span class="badge warn">${esc(t('overlapN', { n: c.overlapDays }))}</span>` : '') +
          tipHtml(warns.concat(infos).join('\n'), warns.length ? 'warn' : '');
      cnote.hidden = !cnote.innerHTML;
    }
  }

  /* ---------------- 修改 ---------------- */
  function applyPreset(key, silent) {
    f.preset = key;
    if (key !== 'custom') {
      const r = TTPeriod.presetRange(key, today());
      f.from = r.from;
      f.to = r.to;
    }
    if (key === 'all') f.mode = 'none';
    if (!silent) emit('preset');
  }

  function onDateChange(which) {
    const fixed = TTPeriod.normalizeRange($('#from').value, $('#to').value, {
      max: today(),
      changed: which,
      fallbackFrom: f.from,
      fallbackTo: f.to,
    });
    f.from = fixed.from;
    f.to = fixed.to;
    f.preset = TTPeriod.matchPreset(f.from, f.to, today());
    if (f.preset === 'all') f.mode = 'none';
    if (fixed.fixes.length) toast(fixed.fixes.map((x) => t('fix_' + x)).join(' · '), 'warn');
    emit('date');
  }

  function onCustomCompareChange(which) {
    const a = $('#cmpFrom').value;
    const b = $('#cmpTo').value;
    if (!a || !b) {
      f.cmpFrom = a;
      f.cmpTo = b;
      return emit('compare');
    }
    const fixed = TTPeriod.normalizeRange(a, b, { max: today(), changed: which, fallbackFrom: f.cmpFrom || a, fallbackTo: f.cmpTo || b });
    f.cmpFrom = fixed.from;
    f.cmpTo = fixed.to;
    if (fixed.fixes.length) toast(fixed.fixes.map((x) => t('fix_' + x)).join(' · '), 'warn');
    emit('compare');
  }

  function setMode(mode) {
    f.mode = MODE_KEYS.includes(mode) ? mode : 'none';
    if (f.mode === 'custom' && !(f.cmpFrom && f.cmpTo)) {
      // 自定义的初始值给「上一周期」，用户在此基础上改
      const p = TTPeriod.compareRange('previous', f.from, f.to);
      if (p) {
        f.cmpFrom = p.from;
        f.cmpTo = p.to;
      }
    }
    emit('compare');
  }

  /** 载入历史任务时把筛选同步成该任务的区间（不触发「区间改变」逻辑） */
  function setFromJob(job) {
    f.from = job.currentFrom;
    f.to = job.currentTo;
    f.preset = TTPeriod.matchPreset(f.from, f.to, today());
    f.mode = job.compareMode || 'none';
    if (f.mode === 'custom') {
      f.cmpFrom = job.compareFrom || '';
      f.cmpTo = job.compareTo || '';
    }
    prefs.set('filter', { preset: f.preset, from: f.from, to: f.to, mode: f.mode, cmpFrom: f.cmpFrom, cmpTo: f.cmpTo });
    render();
  }

  /* ---------------- 日期框：整块可点 ---------------- */
  function bindDateField(field) {
    const input = field.querySelector('input[type="date"]');
    if (!input) return;
    const open = () => {
      if (input.disabled) return;
      try {
        if (typeof input.showPicker === 'function') input.showPicker();
        else input.focus();
      } catch (_) {
        // 某些环境（非用户手势、跨源 iframe）会拒绝 showPicker：退回聚焦，用户仍可键入或点图标
        input.focus();
      }
    };
    // 点击输入框本身：原生日历按钮已被拉伸覆盖整个输入框（CSS）；这里再主动调一次 showPicker，
    // 兼容覆盖层不生效的平台。选择器已经打开时 showPicker 会抛错，被 open() 内的 try 吞掉，不会重复弹出。
    field.addEventListener('click', open);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || (e.altKey && e.key === 'ArrowDown')) {
        e.preventDefault();
        open();
      }
    });
    input.addEventListener('focus', () => field.classList.add('focus'));
    input.addEventListener('blur', () => field.classList.remove('focus'));
  }

  function init() {
    const saved = prefs.get('filter', null);
    if (saved && saved.preset && saved.preset !== 'custom') {
      applyPreset(saved.preset, true);
    } else if (saved && TTPeriod.isValid(saved.from) && TTPeriod.isValid(saved.to)) {
      const fx = TTPeriod.normalizeRange(saved.from, saved.to, { max: today() });
      f.from = fx.from;
      f.to = fx.to;
      f.preset = TTPeriod.matchPreset(f.from, f.to, today());
    } else {
      applyPreset('thisMonth', true);
    }
    if (saved) {
      f.mode = MODE_KEYS.includes(saved.mode) ? saved.mode : 'none';
      f.cmpFrom = saved.cmpFrom || '';
      f.cmpTo = saved.cmpTo || '';
    }

    renderPresets();
    renderModes();
    $('#presetSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      if (b.dataset.preset === 'custom') {
        f.preset = 'custom';
        render();
        const field = $('#from').closest('.date-field');
        if (field) field.click();
        return;
      }
      applyPreset(b.dataset.preset);
    });
    // 方向键在分段按钮之间移动（radiogroup 的标准键盘行为）
    $('#presetSeg').addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const btns = $$('#presetSeg [data-preset]');
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length].focus();
    });
    $('#from').addEventListener('change', () => onDateChange('from'));
    $('#to').addEventListener('change', () => onDateChange('to'));
    $('#cmpFrom').addEventListener('change', () => onCustomCompareChange('from'));
    $('#cmpTo').addEventListener('change', () => onCustomCompareChange('to'));
    $('#cmpMode').addEventListener('change', (e) => setMode(e.target.value));
    $$('.date-field').forEach(bindDateField);
    render();
  }

  /** 切换语言后重绘文案 */
  function relabel() {
    renderPresets();
    renderModes();
    render();
  }

  return {
    init,
    relabel,
    snapshot,
    compare,
    setFromJob,
    onChange: (fn) => listeners.push(fn),
    get value() {
      return { ...f };
    },
  };
})();

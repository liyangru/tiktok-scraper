/* ============================================================
   统一折叠组件：所有图表区域、周期对比、任务详情都用这一份。

   - 整个标题栏可点击（不只是小箭头）；标题栏里的按钮 / 输入框等自身交互不会触发折叠
   - role=button + aria-expanded + aria-controls；Enter / 空格可切换
   - 收起时内容区设 inert：不能被 Tab 聚焦，读屏也会跳过
   - 高度动画用 grid-template-rows 0fr ↔ 1fr，纯 CSS，不需要测量高度
   - 状态按 id 持久化在 localStorage；重新渲染、切换账号/筛选时读回，不会被重置
   ============================================================ */
const TTCollapse = (() => {
  const KEY = 'collapse';
  let store = prefs.get(KEY, {}) || {};

  const isOpen = (id, def) => (Object.prototype.hasOwnProperty.call(store, id) ? !!store[id] : !!def);
  function remember(id, open) {
    store[id] = open ? 1 : 0;
    prefs.set(KEY, store);
  }
  const domId = (id) => 'cx-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

  /**
   * 生成折叠区 HTML。
   * @param {object} o
   *   id        持久化用的唯一标识（如 'chart:daily'）
   *   title     标题
   *   meta      口径说明（纯文本）：收进标题旁的 ⓘ 悬浮提示，不占版面
   *   summary   摘要 HTML：收起时保留在标题栏里，避免收起后只剩一行字
   *   extra     标题栏右侧的操作 HTML（按钮、分段切换等），点击不触发折叠
   *   body      内容 HTML
   *   open      默认是否展开（用户操作过之后以用户的为准）
   *   variant   'section'（大区块）| 'item'（区块里的小图表）
   */
  function html(o) {
    const id = String(o.id);
    const open = isOpen(id, o.open);
    const bid = domId(id) + '-body';
    const v = o.variant || 'section';
    return `<section class="cx cx-${v}${o.cls ? ' ' + o.cls : ''}" data-cx="${esc(id)}" data-open="${open ? 1 : 0}">
      <div class="cx-head" role="button" tabindex="0" aria-expanded="${open}" aria-controls="${bid}">
        <span class="cx-chev" aria-hidden="true"></span>
        <div class="cx-titles">
          <span class="cx-title">${o.title || ''}</span>
          ${o.meta ? `<i class="tip down" tabindex="0" data-no-toggle data-tip="${o.meta}"></i>` : ''}
        </div>
        ${o.summary ? `<div class="cx-summary">${o.summary}</div>` : '<div class="cx-summary"></div>'}
        ${o.extra ? `<div class="cx-extra">${o.extra}</div>` : ''}
      </div>
      <div class="cx-body" id="${bid}" role="region"${open ? '' : ' inert'}>
        <div class="cx-inner">${o.body || ''}</div>
      </div>
    </section>`;
  }

  function set(sec, open, persist = true) {
    if (!sec) return;
    sec.dataset.open = open ? '1' : '0';
    const head = sec.querySelector(':scope > .cx-head');
    const body = sec.querySelector(':scope > .cx-body');
    if (head) head.setAttribute('aria-expanded', String(open));
    if (body) {
      if (open) body.removeAttribute('inert');
      else body.setAttribute('inert', '');
    }
    if (persist) remember(sec.dataset.cx, open);
    sec.dispatchEvent(new CustomEvent('cx-toggle', { bubbles: true, detail: { id: sec.dataset.cx, open } }));
  }
  const toggle = (sec) => set(sec, sec.dataset.open !== '1');

  /** 标题栏里这些元素有自己的交互，点它们不应该折叠 */
  const OWN_INTERACTIVE = 'button, a, input, select, textarea, label, [data-no-toggle], .tip';

  function init() {
    document.addEventListener('click', (e) => {
      const head = e.target.closest('.cx-head');
      if (!head) return;
      const hit = e.target.closest(OWN_INTERACTIVE);
      if (hit && head.contains(hit) && hit !== head) return;
      toggle(head.parentElement);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const head = e.target;
      if (!head.classList || !head.classList.contains('cx-head')) return;
      e.preventDefault();
      toggle(head.parentElement);
    });
  }

  /** 某个折叠区内容区的 DOM（局部更新内容用，不重建标题栏、不丢失状态） */
  const bodyOf = (id) => {
    const sec = document.querySelector(`.cx[data-cx="${CSS.escape(String(id))}"]`);
    return sec ? sec.querySelector(':scope > .cx-body > .cx-inner') : null;
  };

  return { html, init, set, toggle, isOpen, bodyOf };
})();

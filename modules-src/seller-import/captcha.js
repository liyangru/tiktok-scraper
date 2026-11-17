/**
 * 滑块验证码 AI 尝试（实验性）
 *
 * 流程：找到验证码容器 → 截图 → 视觉模型定位缺口距离 → 拟人拖拽 → 验证。
 * 失败自动重试（最多 3 次），全失败返回 { solved:false }，调用方降级为开窗人工。
 *
 * 诚实说明：TikTok 的验证码（zti_web / secsdk）不保证每次都能过，视觉定位有误差，
 * 且拖拽轨迹反爬可能升级。这是「能省一次人工就省」的尝试，不是承诺。
 */
const HUMANIZE = true;

/** 在页面与所有 iframe 里找验证码容器 */
async function findCaptcha(page) {
  const sels = [
    '[class*="captcha"]',
    '[id*="captcha"]',
    '[class*="secsdk"]',
    'iframe[src*="captcha"]',
    '[class*="slider"]',
    '[class*="verify"]',
  ];
  const frames = [page.mainFrame()].concat(page.frames());
  for (const f of frames) {
    for (const s of sels) {
      try {
        const el = await f.$(s);
        if (el) {
          const box = await el.boundingBox();
          if (box && box.width > 60 && box.height > 30) return { el, frame: f, page, box, sel: s };
        }
      } catch (_) {}
    }
  }
  return null;
}

/** 拟人拖拽：ease-out + 轻微过冲 + 抖动 */
async function humanDrag(page, from, dx) {
  const steps = 24;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    // ease-out cubic：前快后慢，像手推
    const eased = 1 - Math.pow(1 - p, 3);
    const jitter = (Math.random() - 0.5) * 2;
    const overshoot = p > 0.92 ? 3 * (p - 0.92) / 0.08 : 0; // 末段过冲 3px 再回来
    await page.mouse.move(from.x + dx * eased + overshoot + jitter, from.y + (Math.random() - 0.5) * 2);
    await page.waitForTimeout(8 + Math.floor(Math.random() * 18));
  }
  await page.waitForTimeout(120);
  await page.mouse.up();
}

/** 尝试解一次滑块；返回 { solved, reason } */
async function trySolve(page, ctx) {
  const found = await findCaptcha(page);
  if (!found) return { solved: false, reason: '未找到验证码元素' };
  const { el, page: pg } = found;
  const box = await el.boundingBox();
  if (!box) return { solved: false, reason: '验证码元素无位置' };

  const shot = await el.screenshot();
  const b64 = shot.toString('base64');

  // 视觉定位：直接问缺口距离（要求只回整数）
  let ans = '';
  try {
    ans = await ctx.core.llm.chatVision(
      'This is a slider captcha screenshot. Output ONLY one integer: the horizontal pixel distance from the left edge of the slider handle to the center of the gap/notch. No explanation.',
      [b64],
      { temperature: 0 }
    );
  } catch (e) {
    return { solved: false, reason: '视觉模型不可用：' + e.message };
  }
  const digits = String(ans).replace(/[^0-9]/g, ' ').trim().split(/\s+/)[0];
  const dx = parseInt(digits, 10);
  if (!dx || dx < 10 || dx > box.width * 1.5) {
    return { solved: false, reason: '视觉定位结果不可信: ' + String(ans).slice(0, 40) };
  }

  // 滑块把手：容器左缘中部（大多数滑块的把手在起点）
  const from = { x: box.x + 14, y: box.y + box.height / 2 };
  await humanDrag(pg, from, dx);
  await page.waitForTimeout(1800);

  // 验证：URL 离开登录页，或验证码元素消失
  const u = page.url();
  if (u && !/account\/login/i.test(u)) return { solved: true, dx };
  const still = await findCaptcha(page);
  if (!still) return { solved: true, dx };
  return { solved: false, dx, reason: `拖拽了 ${dx}px 但验证未通过` };
}

/** 带重试的入口（最多 3 次） */
async function solveWithRetry(page, ctx, max = 3) {
  // 视觉模型没配置就别折腾了
  try {
    ctx.core.llm.cfg();
  } catch (e) {
    return { solved: false, reason: e.message };
  }
  const attempts = [];
  for (let i = 1; i <= max; i++) {
    const r = await trySolve(page, ctx);
    attempts.push(`第${i}次: ${r.reason || '通过(' + r.dx + 'px)'}`);
    if (r.solved) return { solved: true, attempts };
    await page.waitForTimeout(1500);
  }
  return { solved: false, reason: attempts.join('；') };
}

module.exports = { solveWithRetry, findCaptcha };

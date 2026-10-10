/**
 * 浏览器定位 / 解压（跨平台）
 * ------------------------------------------------------------------
 * 自带 Chromium 的解压结构各平台不同：
 *   Windows : chromium-<rev>/chrome-win64/chrome.exe
 *   macOS   : chromium-<rev>/chrome-mac[-arm64]/Chromium.app/Contents/MacOS/Chromium
 *   Linux   : chromium-<rev>/chrome-linux/chrome
 * 这里统一探测，避免各处硬编码。
 */
const fs = require('fs');
const path = require('path');

/** 各平台 chromium 主程序的文件名（不含 Helper / crashpad 之类的附属程序） */
const BIN_NAMES = new Set([
  'chrome.exe',
  'chrome',
  'chromium',
  'Chromium',
  'Google Chrome for Testing',
]);

/** 广度优先找主程序；限制层数，避免在大目录里瞎翻 */
function walkForBinary(root, maxDepth) {
  let level = [root];
  for (let d = 0; d <= maxDepth && level.length; d++) {
    const next = [];
    for (const dir of level) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isFile()) {
          if (BIN_NAMES.has(e.name)) return full;
        } else if (e.isDirectory()) {
          next.push(full);
        }
      }
    }
    level = next;
  }
  return null;
}

/** 在 browsersDir 里找可用的 chromium 可执行文件；找不到返回 null */
function findChromium(browsersDir) {
  if (!browsersDir || !fs.existsSync(browsersDir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(browsersDir).filter((d) => /^chromium(-\d+)?$/.test(d));
  } catch (_) {
    return null;
  }
  for (const d of entries) {
    const base = path.join(browsersDir, d);
    // 常见布局先走快路径
    const candidates = [
      path.join(base, 'chrome-win64', 'chrome.exe'),
      path.join(base, 'chrome-win', 'chrome.exe'),
      path.join(base, 'chrome-linux', 'chrome'),
      path.join(base, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      path.join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    // 兜底：Chrome for Testing 的 bundle 名与 Chromium 不同，且载荷可能存在额外嵌套，
    // 所以做一次有层数上限的广度搜索，按文件名精确匹配。
    const found = walkForBinary(base, 5);
    if (found) return found;
  }
  return null;
}

/**
 * 确保浏览器就绪：优先用已解压的；否则从 payload 解压。
 * @param {string} baseDir    可写基目录（浏览器解压到 <baseDir>/browsers）
 * @param {string[]} payloads 候选载荷路径（tar.gz）
 * @returns {string|null} chromium 可执行文件路径
 */
function ensureBrowsers(baseDir, payloads = []) {
  const browsersDir = path.join(baseDir, 'browsers');

  let exe = findChromium(browsersDir);
  if (exe) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir;
    process.env.CHROME_PATH = exe;
    return exe;
  }

  const payload = payloads.filter(Boolean).find((p) => fs.existsSync(p));
  if (!payload) return null;

  console.log('[browsers] 首次运行：正在解压内置 Chromium（仅此一次）...');
  fs.mkdirSync(browsersDir, { recursive: true });
  require('tar').x({ file: payload, cwd: browsersDir, sync: true });

  exe = findChromium(browsersDir);
  if (exe) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir;
    process.env.CHROME_PATH = exe;
    console.log('[browsers] Chromium 就绪:', exe);
  } else {
    console.error('[browsers] 解压后仍未找到 chromium 可执行文件');
  }
  return exe;
}

module.exports = { ensureBrowsers, findChromium };

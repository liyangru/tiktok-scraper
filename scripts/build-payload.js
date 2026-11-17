#!/usr/bin/env node
/**
 * 生成自带 Chromium 载荷 browser-payload.tar.gz（**裁剪版**）
 * ------------------------------------------------------------------
 * 为什么要自己打一遍：
 *   playwright 原包 441MB（gzip 后 199MB），里面一大半是本机抓取根本用不到的东西
 *   —— 多语言包、WebGPU/SwiftShader 软件渲染、安装器、PWA 启动器、录制用的 ffmpeg……
 *   裁掉后仍能正常无头抓取 + 有头登录，体积明显下降，安装更快。
 *
 * 输入（自动挑一个）：
 *   1) --from <dir>            指定已解压的 playwright 浏览器目录
 *   2) ms-playwright 缓存目录   （CI 里 npx playwright install chromium 之后）
 *   3) 已有的 browser-payload.tar.gz（解压后重新裁剪打包）
 *
 * 输出：<项目根>/browser-payload.tar.gz
 *
 * ⚠️ **只删「确定不影响抓取与登录」的东西**。任何拿不准的一律保留 ——
 *    省几 MB 换来「别人的机器上起不来」完全不划算。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'browser-payload.tar.gz');
const HUMAN = (n) => (n / 1048576).toFixed(1) + 'MB';

/* ---------------- 裁剪清单 ---------------- */

/** 顶层目录里整块不要的（ffmpeg 是录视频用的，winldd 是依赖扫描工具） */
const DROP_TOP_DIRS = [/^ffmpeg-\d+$/, /^winldd-\d+$/];

/** 浏览器目录里整块不要的 */
const DROP_SUBDIRS = [
  'hyphen-data',
  'MEIPreload',
  'IwaKeyDistribution',
  'swiftshader',
  'resources/accessibility',
];

/** 明确不需要的单文件（都是 GPU / 安装 / 更新 / 通知 / PWA 相关） */
const DROP_FILES = new Set([
  'setup.exe',
  'dxcompiler.dll',
  'dxil.dll',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'libvk_swiftshader.so',
  'libvulkan.so.1',
  'libEGL.so',
  'libGLESv2.so',
  'D3DCompiler_47.dll',
  'vulkan-1.dll',
  'elevation_service.exe',
  'elevated_tracing_service.exe',
  'chrome_pwa_launcher.exe',
  'chrome_proxy.exe',
  'notification_helper.exe',
  'chrome_200_percent.pak',
  'chrome_crashpad_handler',
]);

/** 语言包只留这几个（en-US 是兜底；th 给泰区抓取；zh 给中文界面） */
const KEEP_LOCALES = new Set(['en-US.pak', 'th.pak', 'zh-CN.pak', 'zh-TW.pak']);

/** 一定保留，防止误删（哪怕上面的清单里出现了也不删） */
const KEEP_FILES = new Set([
  'chrome.dll',
  'chrome',
  'chrome.exe',
  'headless_shell',
  'resources.pak',
  'icudtl.dat',
  'chrome_100_percent.pak',
  'chrome_elf.dll',
  'v8_context_snapshot.bin',
  'v8_context_snapshot.x86_64.bin',
  'libffmpeg.so',
]);

const BIN_NAMES = new Set(['chrome.exe', 'chrome', 'chromium', 'headless_shell']);

/* ---------------- 定位源 ---------------- */

function msPlaywrightDir() {
  const base =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
        : path.join(os.homedir(), '.cache', 'ms-playwright'));
  return fs.existsSync(base) ? base : null;
}

function findChromiumRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    if (!/^(chromium|chromium_headless_shell)(-\d+)?$/.test(name)) continue;
    const base = path.join(dir, name);
    const quick = [
      path.join(base, 'chrome-win64', 'chrome.exe'),
      path.join(base, 'chrome-win', 'chrome.exe'),
      path.join(base, 'chrome-linux', 'chrome'),
      path.join(base, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      path.join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
    if (quick.some((p) => fs.existsSync(p))) return base;
  }
  return null;
}

async function stageFromTarball(stage) {
  console.log('[payload] 源：已有 browser-payload.tar.gz（解出来重新裁剪）');
  await tar.x({ file: OUT, cwd: stage });
  return true;
}

function stageFromDir(stage, srcRoot) {
  console.log('[payload] 源：' + srcRoot);
  // 只带 chromium 本体；ffmpeg-*/winldd-* 本来就不要
  const dest = path.join(stage, path.basename(srcRoot));
  fs.cpSync(srcRoot, dest, { recursive: true, dereference: false });
  return true;
}

/* ---------------- 裁剪 ---------------- */

function prune(stage) {
  let freed = 0;
  let removed = 0;

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 顶层整块丢弃
        if (dir === stage && DROP_TOP_DIRS.some((re) => re.test(e.name))) {
          freed += dirSize(full);
          fs.rmSync(full, { recursive: true, force: true });
          removed++;
          continue;
        }
        if (DROP_SUBDIRS.includes(e.name)) {
          freed += dirSize(full);
          fs.rmSync(full, { recursive: true, force: true });
          removed++;
          continue;
        }
        walk(full);
        continue;
      }
      // 语言包：只保留白名单
      if (path.basename(path.dirname(full)) === 'locales' && !KEEP_LOCALES.has(e.name)) {
        freed += fileSize(full);
        fs.rmSync(full, { force: true });
        removed++;
        continue;
      }
      if (KEEP_FILES.has(e.name)) continue;
      if (DROP_FILES.has(e.name) || /\.(pdb|map|dSYM)$/i.test(e.name)) {
        freed += fileSize(full);
        fs.rmSync(full, { force: true });
        removed++;
      }
    }
  };

  walk(stage);
  return { freed, removed };
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}
function dirSize(d) {
  let sum = 0;
  const stack = [d];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else sum += fileSize(p);
    }
  }
  return sum;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const argIdx = process.argv.indexOf('--from');
  const explicit = argIdx > -1 ? process.argv[argIdx + 1] : null;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ttpayload-'));
  const stage = path.join(tmp, 'stage');
  fs.mkdirSync(stage, { recursive: true });

  try {
    /* ⚠️ 优先级：已有载荷 > 本地缓存。
       已有载荷是和当前 patchright 版本配套、CI 验证过的那个（chromium-1248）；
       本地 ms-playwright 缓存可能是别的 playwright 版本留下的（1243），
       拿它打包会让「本机跑得好好的、别人装完起不来」的风险变大。 */
    let srcRoot = explicit ? findChromiumRoot(explicit) || explicit : null;
    if (!srcRoot && !fs.existsSync(OUT)) srcRoot = findChromiumRoot(msPlaywrightDir());

    if (srcRoot) {
      stageFromDir(stage, srcRoot);
    } else if (fs.existsSync(OUT)) {
      await stageFromTarball(stage);
    } else {
      console.error('[payload] 找不到 Chromium 源：先跑 npx playwright install chromium，或把已有 browser-payload.tar.gz 放回项目根');
      process.exit(1);
    }

    const before = dirSize(stage);
    const { freed, removed } = prune(stage);
    const after = dirSize(stage);

    // 自检：浏览器**可执行文件**必须还在（只认 chrome.exe / chrome / headless_shell，
    // 不能把 chrome.dll 之类算进去 —— 那样自检会假通过，包出去却是坏的）
    const foundBin = (() => {
      const stack = [stage];
      for (let i = 0; i < 6 && stack.length; i++) {
        const next = [];
        for (const d of stack) {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isFile() && BIN_NAMES.has(e.name)) return p;
            if (e.isDirectory()) next.push(p);
          }
        }
        stack.length = 0;
        stack.push(...next);
      }
      return null;
    })();
    if (!foundBin) {
      console.error('[payload] 裁剪后找不到浏览器主程序 —— 已放弃写盘，保留原载荷');
      process.exit(1);
    }

    const bak = OUT + '.bak';
    if (fs.existsSync(OUT)) fs.copyFileSync(OUT, bak);

    const stageEntries = fs.readdirSync(stage).filter((n) => n !== '.');
    await tar.c(
      {
        file: OUT,
        gzip: { level: 9 },
        cwd: stage,
        portable: true,
        noMtime: true,
      },
      stageEntries
    );

    const outSize = fs.statSync(OUT).size;
    console.log(`[payload] 裁剪：删掉 ${removed} 项，省 ${HUMAN(freed)}（${HUMAN(before)} → ${HUMAN(after)}）`);
    console.log(`[payload] 主程序：${path.relative(stage, foundBin)}`);
    console.log(`[payload] 输出：${OUT}  ${HUMAN(outSize)}`);
    if (fs.existsSync(bak)) console.log(`[payload] 原载荷备份：${bak} ${HUMAN(fs.statSync(bak).size)}（确认可用后可删）`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((e) => {
  console.error('[payload] 失败:', e.message);
  process.exit(1);
});

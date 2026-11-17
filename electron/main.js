/**
 * Electron 主进程 —— 把 Express 服务 + 抓取引擎装进一个原生应用窗口。
 *
 * 相比之前「pkg exe + 自带 Chromium 的 --app 窗口」：
 *   - 无控制台窗口
 *   - 无浏览器外壳，也不会出现 "Chrome 测试版" 提示横幅
 *   - 单实例；关窗即退出；可反复打开
 *   - 数据分析在 Electron 自身进程完成，无浏览器依赖
 */
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// 单实例：第二次启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---- 运行环境 ----
app.disableHardwareAcceleration(); // 关硬件加速：数据面板用不到，且在虚拟机/远程桌面/受限环境更稳
// ⚠️ 实测：只调 disableHardwareAcceleration 不够 —— 受限环境下 GPU 进程仍会崩
//    （FATAL: GPU process isn't usable. Goodbye.）导致整个应用退出。这几条必须都加。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-dev-shm-usage');
// 受限环境下网络服务也会崩（Network service crashed）→ 关沙箱
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');
app.commandLine.appendSwitch('no-proxy-server'); // 界面只连本机 127.0.0.1，避免系统代理把 loopback 也代理走
app.commandLine.appendSwitch('disable-http-cache');
process.env.NO_AUTO_OPEN = '1'; // 不再开外部浏览器 / Chromium 窗口
if (process.env.BROWSER_HEADLESS === undefined) process.env.BROWSER_HEADLESS = '1';

const BASE_DIR = app.getPath('userData');
process.env.TT_BASE_DIR = BASE_DIR;


let win = null;

/**
 * ⚠️ 主进程兜底：Electron 默认遇到未捕获异常会直接弹框退出，用户只看到「应用没了」。
 * 这里改成记日志 + 继续活着 —— 界面还在，用户至少能把数据导出 / 换个操作重试。
 */
process.on('uncaughtException', (e) => {
  console.error('[app] uncaughtException:', (e && e.stack) || e);
  try {
    fs.appendFileSync(
      path.join(BASE_DIR, 'crash.log'),
      `[${new Date().toISOString()}] main uncaughtException: ${(e && e.stack) || e}\n`
    );
  } catch (_) {}
});
process.on('unhandledRejection', (e) => {
  console.error('[app] unhandledRejection:', (e && e.stack) || e);
  try {
    fs.appendFileSync(
      path.join(BASE_DIR, 'crash.log'),
      `[${new Date().toISOString()}] main unhandledRejection: ${(e && e.stack) || e}\n`
    );
  } catch (_) {}
});

/**
 * 启动闪屏 —— 首次运行要解压自带 Chromium（160MB+），再加服务启动，实测有 10~15 秒空白。
 * 用户要求「不要在桌面空等」：这段时间用一个小窗交代清楚在做什么、干到哪一步了。
 * 纯本地 HTML（不进 asar 之外的网络依赖），主进程用 executeJavaScript 推进度。
 */
let splash = null;
function createSplash() {
  splash = new BrowserWindow({
    width: 380,
    height: 300,
    frame: false,
    resizable: false,
    movable: true,
    closable: false,   // 不让用户手滑关掉闪屏（否则会把启动流程一起关掉）
    center: true,
    skipTaskbar: false,
    show: false,
    backgroundColor: '#fbfbfb',
    title: 'TikTok 数据分析',
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.once('ready-to-show', () => splash.show());
  // 调试钩子：TT_SHOT_SPLASH=<png> 时闪屏一出现就截图（用于自动化验收启动动画）
  if (process.env.TT_SHOT_SPLASH) {
    splash.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 600));
      try {
        const img = await splash.webContents.capturePage();
        require('fs').writeFileSync(process.env.TT_SHOT_SPLASH, img.toPNG());
        console.log('[splash] shot saved:', process.env.TT_SHOT_SPLASH);
      } catch (e) {
        console.log('[splash] shot failed:', e && e.message);
      }
    });
  }
  splash.on('closed', () => (splash = null));
}
/** 闪屏语言：优先 env，其次 settings.core.lang，默认中文（应用内语言存 localStorage，闪屏读不到） */
function splashLang() {
  const env = String(process.env.TT_LANG || '').trim();
  if (['zh', 'th', 'en'].includes(env)) return env;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'settings.json'), 'utf8'));
    const l = String((s.core && s.core.lang) || '').trim();
    if (['zh', 'th', 'en'].includes(l)) return l;
  } catch (_) {}
  return 'zh';
}
function splashStep(pct, sub) {
  if (!splash || splash.isDestroyed()) return;
  try {
    splash.webContents.executeJavaScript(
      `window.__boot(${pct}, ${JSON.stringify(String(sub || ''))}, ${JSON.stringify(splashLang())})`
    );
  } catch (_) {}
}
function closeSplash() {
  if (!splash || splash.isDestroyed()) return;
  // ⚠️ 必须用 destroy()，不能用 close()：闪屏是 closable:false，
  //    Electron 会直接忽略 close() 请求 —— 结果就是主界面出来了、闪屏永远卡在 92%「正在打开界面…」。
  try { splash.destroy(); } catch (_) {}
  splash = null;
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: '#fbfbfb',
    title: 'TikTok 数据分析',
    autoHideMenuBar: true,
    // 自定义无边框：应用框与内容融为一体（前端 #titlebar 提供拖动区与三枚窗口按钮）
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  Menu.setApplicationMenu(null);

  // 窗口控制（preload contextBridge → ipcMain）：最小化 / 最大化切换 / 关闭
  ipcMain.on('tt-win', (_e, action) => {
    if (!win) return;
    if (action === 'min') win.minimize();
    else if (action === 'max') win.maximize();
    else if (action === 'toggle') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (action === 'close') win.close();
  });
  ipcMain.handle('tt-win-ismax', () => (win ? win.isMaximized() : false));
  win.once('ready-to-show', () => {
    console.log('[app] ready-to-show');
    win.show();
    // 主窗口真的出来了才收闪屏，中间那一帧空白由闪屏兜住
    setTimeout(closeSplash, 120);
  });
  // 兜底 A：ready-to-show 在「窗口 show:false + 页面持续有资源加载」时可能不触发，
  // 那就等 loadURL 真的 resolve —— 此时界面已经能渲染，直接亮出来。
  win.webContents.on('did-finish-load', () => {
    if (!win.isVisible()) {
      win.show();
      setTimeout(closeSplash, 120);
    }
  });
  // 兜底 B：无论走哪条路，窗口都 show 了就必须在 6 秒内收掉闪屏，
  // 绝不能让用户对着一个永远停在 92% 的窗口干等。
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
    if (splash) {
      console.log('[splash] hard-timeout close');
      closeSplash();
    }
  }, 6000);
  win.webContents.on('did-finish-load', () => console.log('[app] did-finish-load'));
  win.webContents.on('did-fail-load', (e, code, desc, url) =>
    console.log('[app] did-fail-load', code, desc, url)
  );
  // ⚠️ 渲染进程崩了（内存打爆 / GPU 意外）时界面会整片白掉，用户只能杀进程重开。
  // 非正常退出就自动重载一次，把应用拉回可用状态。
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('[app] render-process-gone:', details && details.reason);
    if (!details || details.reason === 'clean-exit') return;
    try { win.webContents.reload(); } catch (_) {}
  });
  console.log('[app] loading http://127.0.0.1:' + port + '/');
  win
    .loadURL(`http://127.0.0.1:${port}/`)
    .then(() => console.log('[app] loadURL resolved'))
    .catch((e) => console.log('[app] loadURL rejected:', e && e.message));

  // 导出文件：下载到系统「下载」目录，并打开所在文件夹
  win.webContents.session.on('will-download', (e, item) => {
    const savePath = path.join(app.getPath('downloads'), item.getFilename());
    item.setSavePath(savePath);
    item.once('done', (_e, state) => {
      if (state === 'completed') shell.showItemInFolder(savePath);
    });
  });
  /**
   * ⚠️ 用户硬要求：**不允许任何功能走系统浏览器**。
   * 所有 http(s) 外链（视频页、卖家中心等）一律在**应用内**开新窗口，
   * 而不是 shell.openExternal 交给系统默认浏览器。
   */
  const openInApp = (url) => {
    const child = new BrowserWindow({
      width: 1100,
      height: 800,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      title: 'TikTok',
      parent: win,
      webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    child.loadURL(url).catch(() => {});
    return child;
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) openInApp(url);
    return { action: 'deny' };
  });
  // 站内跳转如果跑到外部域名，也拉回应用内窗口，不让主窗口离开应用
  win.webContents.on('will-navigate', (e, url) => {
    try {
      const u = new URL(url);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
        e.preventDefault();
        openInApp(url);
      }
    } catch (_) {}
  });
  win.on('closed', () => {
    win = null;
  });

  // 调试用：TT_SHOT=<png路径> 时，页面加载后截图并退出（用于自动化验证界面）
  if (process.env.TT_SHOT) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const img = await win.webContents.capturePage();
      require('fs').writeFileSync(process.env.TT_SHOT, img.toPNG());
      console.log('[app] shot saved:', process.env.TT_SHOT);
      app.quit();
    });
  }
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  app.setAppUserModelId('com.ttscraper.app');

  // 闪屏先起，覆盖后面的解压 + 服务启动全程
  createSplash();
  splashStep(6, 'L:1');

  try {
    splashStep(14, 'L:2');
    splashStep(62, 'L:3');
  } catch (e) {
    console.error('[app] 启动准备失败:', e && e.message);
    splashStep(62, 'L:6');
  }

  const server = require('../server');
  try {
    /* ⚠️ 端口由服务自己探测后返回 —— 绝不在这里拼默认端口。
       用户机器上 8899 多半被别的软件占着，写死就会出现「打开是白屏/是别人的服务」。 */
    splashStep(78, 'L:4');
    const port = await server.start();
    splashStep(92, 'L:5');
    createWindow(port);
  } catch (e) {
    console.error('[app] 服务启动失败:', e && e.message);
    closeSplash();
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());

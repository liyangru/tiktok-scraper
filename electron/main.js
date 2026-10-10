/**
 * Electron 主进程 —— 把 Express 服务 + 抓取引擎装进一个原生应用窗口。
 *
 * 相比之前「pkg exe + 自带 Chromium 的 --app 窗口」：
 *   - 无控制台窗口
 *   - 无浏览器外壳，也不会出现 "Chrome 测试版" 提示横幅
 *   - 单实例；关窗即退出；可反复打开
 *   - 抓取仍用自带 Chromium（无头），界面用 Electron 自己的窗口
 */
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// 单实例：第二次启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---- 运行环境 ----
app.disableHardwareAcceleration(); // 关硬件加速：数据面板用不到，且在虚拟机/远程桌面/受限环境更稳
app.commandLine.appendSwitch('no-proxy-server'); // 界面只连本机 127.0.0.1，避免系统代理把 loopback 也代理走
app.commandLine.appendSwitch('disable-http-cache');
process.env.NO_AUTO_OPEN = '1'; // 不再开外部浏览器 / Chromium 窗口
if (process.env.BROWSER_HEADLESS === undefined) process.env.BROWSER_HEADLESS = '1';

const BASE_DIR = app.getPath('userData');
process.env.TT_BASE_DIR = BASE_DIR;

const { ensureBrowsers } = require('../lib/browsers');

/** 首次运行解压自带 Chromium（安装包 extraResources 里的 browser-payload.tar.gz） */
function setupBrowsers() {
  return ensureBrowsers(BASE_DIR, [
    process.resourcesPath ? path.join(process.resourcesPath, 'browser-payload.tar.gz') : null,
    path.join(__dirname, '..', 'browser-payload.tar.gz'),
  ]);
}

let win = null;

function createWindow(port) {
  win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: '#fbfbfb',
    title: 'TikTok 多账号数据抓取',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => {
    console.log('[app] ready-to-show');
    win.show();
  });
  win.webContents.on('did-finish-load', () => console.log('[app] did-finish-load'));
  win.webContents.on('did-fail-load', (e, code, desc, url) =>
    console.log('[app] did-fail-load', code, desc, url)
  );
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
  // 页面里的外链（视频链接）走系统默认浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
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
  try {
    setupBrowsers();
  } catch (e) {
    console.error('[app] 解压浏览器失败:', e && e.message);
  }

  const { start } = require('../server');
  try {
    const port = await start();
    createWindow(port);
  } catch (e) {
    console.error('[app] 服务启动失败:', e && e.message);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());

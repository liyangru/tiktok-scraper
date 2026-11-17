/**
 * preload —— contextIsolation 下只暴露极简窗口控制（白名单）。
 * 渲染进程经 window.TTWin 调用，触碰不到 Node/Electron 其它能力。
 */
const { contextBridge, ipcRenderer } = require('electron');

// 让前端知道当前平台：macOS 用系统红黄绿灯，要隐藏自绘的 Windows 风格按钮
contextBridge.exposeInMainWorld('TTPlatform', process.platform);

contextBridge.exposeInMainWorld('TTWin', {
  minimize: () => ipcRenderer.send('tt-win', 'min'),
  maximize: () => ipcRenderer.send('tt-win', 'max'),
  toggleMax: () => ipcRenderer.send('tt-win', 'toggle'),
  close: () => ipcRenderer.send('tt-win', 'close'),
  isMaximized: () => ipcRenderer.invoke('tt-win-ismax'),
});

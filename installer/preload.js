/** 安装器 preload：只暴露安装需要的几个动作 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  info: () => ipcRenderer.invoke('setup:info'),
  browse: (current) => ipcRenderer.invoke('setup:browse', current),
  install: (opts) => ipcRenderer.invoke('setup:install', opts),
  cancel: () => ipcRenderer.invoke('setup:cancel'),
  launch: (dir) => ipcRenderer.invoke('setup:launch', dir),
  minimize: () => ipcRenderer.invoke('setup:minimize'),
  close: () => ipcRenderer.invoke('setup:close'),
  openFolder: (dir) => ipcRenderer.invoke('setup:openFolder', dir),
  onProgress: (cb) => ipcRenderer.on('setup:progress', (_e, p) => cb(p)),
});

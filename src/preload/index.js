/**
 * Preload —— 通过 contextBridge 安全暴露主进程 API 给渲染进程。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** 枚举匹配的 Incott 鼠标 */
  listDevices: () => ipcRenderer.invoke('mouse:list'),

  /** 打开设备（可传 path，缺省自动选第一个） */
  openDevice: (path) => ipcRenderer.invoke('mouse:open', path),

  /** 关闭设备 */
  closeDevice: () => ipcRenderer.invoke('mouse:close'),

  /** 当前设备状态 */
  getState: () => ipcRenderer.invoke('mouse:state'),

  /** 协议常量（键码表、轮询率、DPI 范围等 UI 数据） */
  getConstants: () => ipcRenderer.invoke('mouse:constants'),

  /** 执行写命令：exec(action, ...args) */
  exec: (action, ...args) => ipcRenderer.invoke('mouse:exec', action, ...args),

  /** 读取：read(readType, ...args) */
  read: (readType, ...args) => ipcRenderer.invoke('mouse:read', readType, ...args),

  /** 批量应用（按序 + 间隔）：apply([{action, args, delay}]) */
  apply: (ops) => ipcRenderer.invoke('mouse:apply', ops),

  /** 上传宏到鼠标（编码 320 字节 + 分块上传） */
  uploadMacro: (macro) => ipcRenderer.invoke('mouse:uploadMacro', macro),
});

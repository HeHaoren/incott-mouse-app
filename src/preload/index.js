/**
 * Preload —— 通过 contextBridge 安全暴露主进程 API 给渲染进程。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const i18n = require('../shared/i18n');
const keynames = require('../shared/keynames');

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

  /** 一次性读出整套配置（连接/切换配置时对齐 UI） */
  readConfig: () => ipcRenderer.invoke('mouse:readConfig'),

  /** 订阅鼠标上的配置切换键（硬件只改序号，配置由本工具灌入） */
  onProfile: (cb) => ipcRenderer.on('profile:update', (_e, idx) => cb(idx)),

  /** 订阅设备主动上报的电量（{level, charging}） */
  onBattery: (cb) => ipcRenderer.on('battery:update', (_e, v) => cb(v)),

  /** 订阅 toast 提示（如 DPI 键切换档位） */
  onToast: (cb) => ipcRenderer.on('toast', (_e, msg) => cb(msg)),

  /** 订阅设备断开（拔出/接收器掉线） */
  onDisconnected: (cb) => ipcRenderer.on('device:disconnected', () => cb()),

  /** 批量应用（按序 + 间隔）：apply([{action, args, delay}]) */
  apply: (ops) => ipcRenderer.invoke('mouse:apply', ops),

  // ── 托盘信息浮层 ──────────────────────────────────────────
  /** 浮层要显示的当前状态（连接/电量/DPI 档位/回报率/配置） */
  getTrayStatus: () => ipcRenderer.invoke('tray:status'),
  /** 触发一次实时读取后返回最新状态 */
  refreshTrayStatus: () => ipcRenderer.invoke('tray:refresh'),
  /** 订阅浮层状态推送 */
  onTrayStatus: (cb) => ipcRenderer.on('tray:status', (_e, v) => cb(v)),
  /** 浮层每次弹出（用于播放淡入动画） */
  onPopoverShown: (cb) => ipcRenderer.on('popover:shown', () => cb()),
  /** 收起浮层（Esc） */
  hideTrayPopover: () => ipcRenderer.invoke('tray:hidePopover'),
  /** 收起浮层并打开主窗口 */
  openMainFromTray: () => ipcRenderer.invoke('tray:openMain'),

  /** 上传宏到鼠标（编码 320 字节 + 分块上传） */
  uploadMacro: (macro) => ipcRenderer.invoke('mouse:uploadMacro', macro),

  /** 读取设置（开机自启 / 启动后台保留） */
  getSettings: () => ipcRenderer.invoke('settings:get'),

  /** 应用信息（版本号、主页） */
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  /** 用系统浏览器打开 https 链接 */
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  /** 关于对话框 */
  showAbout: () => ipcRenderer.invoke('app:about'),

  /** 窗口控制（自绘标题栏） */
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximizedChange: (cb) => ipcRenderer.on('window:maximized', (_e, v) => cb(v)),

  /** 更新设置 */
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  /** 导出当前配置为 .ict（弹保存对话框） */
  exportProfile: (profileData) => ipcRenderer.invoke('config:exportProfile', profileData),

  /** 导入 .ict 配置（弹打开对话框） */
  importProfile: () => ipcRenderer.invoke('config:importProfile'),

  /** 导出宏库为 .icm（弹保存对话框） */
  exportMacros: (macros) => ipcRenderer.invoke('config:exportMacros', macros),

  /** 导入 .icm 宏库（弹打开对话框） */
  importMacros: () => ipcRenderer.invoke('config:importMacros'),
});

// 键位显示名（把 LEFT / KeyA 等协议枚举翻成界面文案）
contextBridge.exposeInMainWorld('keynames', {
  keyLabel: (kind, value) => keynames.keyLabel(kind, value, i18n.getLang()),
});

// i18n（渲染进程通过 window.i18n 使用）
contextBridge.exposeInMainWorld('i18n', {
  t: (key) => i18n.t(key),
  getLang: () => i18n.getLang(),
  setLang: (lang) => {
    const l = i18n.setLang(lang);
    ipcRenderer.invoke('i18n:setLang', l); // 同步主进程菜单
    return l;
  },
  onLangChanged: (cb) => {
    ipcRenderer.on('i18n:changed', (_e, lang) => {
      i18n.setLang(lang);
      cb(lang);
    });
  },
});

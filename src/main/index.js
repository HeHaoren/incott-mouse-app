/**
 * Electron 主进程入口。
 *
 * 职责：
 *  - 创建窗口
 *  - 管理鼠标设备（打开/关闭）
 *  - 通过 IPC 暴露语义化操作给渲染进程
 *
 * 协议命令构造全部在 shared/protocol.js（纯函数），HID 通信在 main/hid.js。
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } = require('electron');
const hid = require('./hid');
const P = require('../shared/protocol');
const i18n = require('../shared/i18n');

let device = null; // 当前打开的 MouseDevice
let mainWindow = null;
let tray = null; // 托盘图标
let batteryLevel = null; // 最近一次读到的电量（托盘显示）
let quitting = false; // 是否真正退出（关窗仅隐藏到托盘）
let batteryTimer = null; // 电量轮询定时器
let writing = false; // 写操作进行中（轮询读电量时跳过，避免打断 apply/宏上传序列）

// ── 设置（JSON 持久化到 userData）──────────────────────────
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveSettings(s) {
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

function getSettings() {
  return {
    autoLaunch: !!app.getLoginItemSettings().openAtLogin,
    startMinimized: !!loadSettings().startMinimized,
  };
}

function setSettings(patch) {
  const s = loadSettings();
  if (patch.autoLaunch != null) {
    app.setLoginItemSettings({ openAtLogin: !!patch.autoLaunch });
  }
  if (patch.startMinimized != null) {
    s.startMinimized = !!patch.startMinimized;
  }
  saveSettings(s);
  return getSettings();
}

// ── 操作分发表：action → 命令构造器 ──────────────────────────
const EXEC_ACTIONS = {
  setRate: (hz) => P.buildSetRate(hz),
  setDpi: (index, dpi, flag) => P.buildSetResolution(index, P.dpiToHw(dpi), flag || 0),
  setDpiLevel: (levels, curIndex) => P.buildSetDpiLevel(levels, curIndex),
  setLod: (hw) => P.buildSetLod(hw),
  setRipple: (on) => P.buildSetRipple(on),
  setAngleSnap: (on) => P.buildSetAngleSnap(on),
  setMotionSync: (on) => P.buildSetMotionSync(on),
  setSensorMode: (mode) => P.buildSetSensorMode(mode),
  setDebounce: (t) => P.buildSetDebounce(t),
  setFireKey: (loop, interval) => P.buildSetFireKey(loop, interval),
  setSleepTime: (t) => P.buildSetSleepTime(t),
  setKey: (index, keyType, keyValue) => {
    let code;
    switch (keyType) {
      case 'mouse':
        code = P.encodeMouseKey(keyValue);
        break;
      case 'keyboard': {
        const hidCode = P.HID_KEY_CODES[keyValue];
        if (hidCode == null) throw new Error(`未知键盘键: ${keyValue}`);
        code = P.encodeKeyboardKey(hidCode, 0);
        break;
      }
      case 'media':
        code = P.encodeMediaKey(keyValue);
        break;
      case 'macro':
        code = P.encodeMacroKey(parseInt(keyValue, 10));
        break;
      default:
        throw new Error(`未知按键类型: ${keyType}`);
    }
    return P.buildSetKey(index, code);
  },
  setProfile: (index) => P.buildSetProfile(index),
  setReceiverLed: (mode) => P.buildSetReceiverLed(mode),
};

// ── 读取分发表：readType → { builder, parse } ────────────────
// parse 的 buf 是 hid.js 返回的数据区（8 字节，已剥离 reportId）：
//   buf[0]=命令回显, buf[1..]=参数（实测校准，见 docs/protocol.md §4）
const READ_ACTIONS = {
  dpiLevel: {
    build: () => P.buildReadDpiLevel(),
    parse: (buf) => ({ levels: buf[1], current: buf[2] }),
  },
  battery: {
    build: () => P.buildReadBattery(),
    // 响应（剥离 reportId 后）：buf[0]=0x89 回显, buf[1]=电量百分比(>100 表示充电, 减128)
    parse: (buf) => {
      const raw = buf[1];
      return raw > 100 ? raw - 128 : raw;
    },
  },
  key: {
    build: (index) => P.buildReadKey(index),
    parse: (buf) => (buf[5] << 24) | (buf[4] << 16) | (buf[3] << 8) | buf[2],
  },
  matchInfo: {
    build: () => P.buildReadMatchInfo(),
    parse: (buf) => ({ online: buf[6] === 1 }),
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 电量读取（电压换算）────────────────────────────────────
/**
 * 锂电池电压（mV）→ 电量百分比（分段线性，标称 3.7V 单节锂电）。
 * 0x89 响应的 buf[2]（原「电量」字段）实测为充电进度而非电量——无线时恒 0、
 * 插线充电时恒 99，无法反映真实电量。改用电压实测值换算（物理量，可靠）。
 */
function voltageToPercent(mv) {
  if (!mv || mv <= 3300) return 0;
  if (mv >= 4200) return 100;
  const curve = [
    [4200, 100], [4100, 90], [4000, 78], [3900, 65],
    [3800, 50], [3700, 32], [3600, 15], [3500, 5], [3300, 0],
  ];
  for (let i = 0; i < curve.length - 1; i++) {
    const [v1, p1] = curve[i];
    const [v2, p2] = curve[i + 1];
    if (mv <= v1 && mv >= v2) {
      return Math.round(p1 + (p2 - p1) * (mv - v1) / (v2 - v1));
    }
  }
  return 0;
}

/**
 * 读一次电量（百分比）。读完整 63 字节（剥离 reportId 后），
 * 电压在原始响应 idx60-61（小端）→ 剥离后 buf[59..60]。
 */
async function readBatteryValue() {
  if (!device) return null;
  device.sendFeatureReport(P.buildReadBattery());
  await sleep(50);
  const buf = device.getFeatureReport(63);
  if (buf[0] !== 0x89) return null;
  const mv = (buf[60] << 8) | buf[59];
  return voltageToPercent(mv);
}

function deviceState() {
  return device
    ? {
        opened: true,
        productId: device.productId,
        isWireless: device.isWireless,
        path: device.path,
      }
    : { opened: false };
}

function getConstants() {
  return {
    rateTable: P.RATE_TABLE,
    lodTable: P.LOD_TABLE,
    mouseKeys: Object.keys(P.MOUSE_KEYS),
    mediaKeys: Object.keys(P.MEDIA_KEYS),
    modifiers: P.MODIFIERS,
    hidKeyCodes: P.HID_KEY_CODES,
    keyMatrix: P.KEY_MATRIX,
    sensors: {
      PAW3395: { id: P.SENSOR.PAW3395, maxDpi: P.maxDpiForSensor(P.SENSOR.PAW3395) },
      PAW3950: { id: P.SENSOR.PAW3950, maxDpi: P.maxDpiForSensor(P.SENSOR.PAW3950) },
    },
    dpiStep: 50,
    dpiMin: 50,
  };
}

// ── IPC 注册 ────────────────────────────────────────────────
function registerIpc() {
  ipcMain.handle('mouse:list', () => hid.listDevicesAsync());

  ipcMain.handle('mouse:open', (_e, pathArg) => {
    if (device) device.close();
    device = hid.openDevice(pathArg);
    return deviceState();
  });

  ipcMain.handle('mouse:close', () => {
    if (device) device.close();
    device = null;
    return deviceState();
  });

  ipcMain.handle('mouse:state', () => deviceState());
  ipcMain.handle('mouse:constants', () => getConstants());

  ipcMain.handle('mouse:exec', async (_e, action, ...args) => {
    if (!device) throw new Error('设备未连接，请先连接鼠标');
    const builder = EXEC_ACTIONS[action];
    if (!builder) throw new Error(`未知操作: ${action}`);
    const cmdBytes = builder(...args);
    writing = true;
    try {
      device.sendFeatureReport(cmdBytes);
      return true;
    } finally {
      writing = false;
    }
  });

  ipcMain.handle('mouse:read', async (_e, readType, ...args) => {
    if (!device) throw new Error('设备未连接，请先连接鼠标');
    if (readType === 'battery') {
      const val = await readBatteryValue();
      if (val == null) throw new Error('设备未响应（可能处于休眠状态）');
      return val;
    }
    const def = READ_ACTIONS[readType];
    if (!def) throw new Error(`未知读取: ${readType}`);
    const cmdBytes = def.build(...args);
    device.sendFeatureReport(cmdBytes);
    await sleep(50);
    const buf = device.getFeatureReport(P.REPORT_DATA_LEN);
    // 设备休眠/无响应时返回全 0（buf[0] 无命令回显），视为无效读取，避免解析出错误值
    if (buf[0] !== cmdBytes[0]) {
      throw new Error('设备未响应（可能处于休眠状态）');
    }
    return def.parse(buf);
  });

  // 批量应用：按协议 apply 流程顺序执行一组操作（带间隔）
  ipcMain.handle('mouse:apply', async (_e, ops) => {
    if (!device) throw new Error('设备未连接，请先连接鼠标');
    writing = true;
    try {
      for (const op of ops) {
        const { action, args = [] } = op;
        const builder = EXEC_ACTIONS[action];
        if (!builder) throw new Error(`未知操作: ${action}`);
        device.sendFeatureReport(builder(...args));
        await sleep(op.delay ?? 200);
      }
      return true;
    } finally {
      writing = false;
    }
  });

  // 宏上传：编码 320 字节后分 10 块，每块 feature report 准备 + output report 传数据
  ipcMain.handle('mouse:uploadMacro', async (_e, macro) => {
    if (!device) throw new Error('设备未连接，请先连接鼠标');
    if (macro == null || typeof macro.slot !== 'number') {
      throw new Error('宏数据无效');
    }
    if (macro.uid == null) macro.uid = Date.now() >>> 0;
    const bytes = P.encodeMacro(macro);
    const slot = macro.slot & 0xff;
    writing = true;
    try {
      for (let i = 0; i < 10; i++) {
        device.sendFeatureReport(P.buildMacroBlock(10, i, slot));
        await sleep(80);
        device.sendReport(bytes.slice(i * 32, i * 32 + 32));
        await sleep(80);
      }
      return true;
    } finally {
      writing = false;
    }
  });

  // 语言切换：同步主进程菜单
  ipcMain.handle('i18n:setLang', (_e, lang) => {
    i18n.setLang(lang);
    buildMenu();
    if (tray) tray.setContextMenu(buildTrayMenu());
    return i18n.getLang();
  });

  // 设置（开机自启 / 启动后台保留）
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, patch) => setSettings(patch || {}));
}

/** 构建应用菜单（随语言切换重建） */
function buildMenu() {
  const t = i18n.t;
  const template = [
    {
      label: t('menuFile'),
      submenu: [{ label: t('menuQuit'), role: 'quit' }],
    },
    {
      label: t('menuLanguage'),
      submenu: [
        { label: '中文', type: 'checkbox', checked: i18n.getLang() === 'zh', click: () => { i18n.setLang('zh'); buildMenu(); broadcastLang('zh'); } },
        { label: 'English', type: 'checkbox', checked: i18n.getLang() === 'en', click: () => { i18n.setLang('en'); buildMenu(); broadcastLang('en'); } },
      ],
    },
    {
      label: t('menuHelp'),
      submenu: [
        { label: t('menuAbout'), click: () => { const { dialog } = require('electron'); dialog.showMessageBox({ message: t('aboutText') }); } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 广播语言切换给渲染进程 */
function broadcastLang(lang) {
  if (mainWindow) mainWindow.webContents.send('i18n:changed', lang);
}

// ── 托盘与后台轮询 ─────────────────────────────────────────
function createTrayIcon() {
  // 生成 16x16 蓝色圆点托盘图标（呼应顶栏 brand-dot）
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d <= 6) {
        const idx = (y * size + x) * 4;
        buf[idx] = 0x4d; buf[idx + 1] = 0xa3; buf[idx + 2] = 0xff; buf[idx + 3] = 0xff;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function showMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function buildTrayMenu() {
  const t = i18n.t;
  const items = [{ label: t('trayOpen'), click: () => showMainWindow() }];
  if (batteryLevel != null) {
    items.push({ label: `${t('batteryLabel')}: ${batteryLevel}%`, enabled: false });
  }
  items.push({ type: 'separator' });
  items.push({ label: t('menuQuit'), click: () => { quitting = true; app.quit(); } });
  return Menu.buildFromTemplate(items);
}

function updateTrayBattery(battery) {
  batteryLevel = battery;
  if (!tray) return;
  tray.setToolTip(`Incott Mouse Driver — ${i18n.t('batteryLabel')} ${battery}%`);
  tray.setContextMenu(buildTrayMenu());
}

async function pollBattery() {
  if (!device || writing) return; // 未连接或正在写，跳过本次
  try {
    const val = await readBatteryValue();
    if (val != null) updateTrayBattery(val);
  } catch (_) {
    /* 设备拔出/休眠，忽略本次，下次重试 */
  }
}

function startBatteryPolling() {
  if (batteryTimer) return;
  batteryTimer = setInterval(pollBattery, 60000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 800,
    minHeight: 560,
    title: 'Incott Mouse Driver',
    backgroundColor: '#101418',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // 允许 preload require 本地模块（shared/i18n）
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide(); // 关窗隐藏到托盘，不退出
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  if (loadSettings().startMinimized) {
    mainWindow.hide(); // 启动后台保留：不显示主窗口，仅托盘常驻
  }
  buildMenu(); // 应用菜单（中英文）
  hid.prewarm(); // 后台预枚举设备（不阻塞，连接时秒开）
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Incott Mouse Driver');
  tray.setContextMenu(buildTrayMenu());
  startBatteryPolling();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  if (device) device.close();
  device = null;
  if (batteryTimer) clearInterval(batteryTimer);
  batteryTimer = null;
});

app.on('window-all-closed', () => {
  // 关窗仅隐藏到托盘（见 close 拦截），不退出；真正退出走托盘「退出」/应用菜单 quit
});

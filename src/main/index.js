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
const { app, BrowserWindow, ipcMain } = require('electron');
const hid = require('./hid');
const P = require('../shared/protocol');

let device = null; // 当前打开的 MouseDevice
let mainWindow = null;

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
    parse: (buf) => ((buf[3] << 8) | buf[2]),
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
  ipcMain.handle('mouse:list', () => hid.listDevices());

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
    device.sendFeatureReport(cmdBytes);
    return true;
  });

  ipcMain.handle('mouse:read', async (_e, readType, ...args) => {
    if (!device) throw new Error('设备未连接，请先连接鼠标');
    const def = READ_ACTIONS[readType];
    if (!def) throw new Error(`未知读取: ${readType}`);
    device.sendFeatureReport(def.build(...args));
    await sleep(25);
    const buf = device.getFeatureReport(P.REPORT_DATA_LEN);
    return def.parse(buf);
  });

  // 批量应用：按协议 apply 流程顺序执行一组操作（带间隔）
  ipcMain.handle('mouse:apply', async (_e, ops) => {
    if (!device) throw new Error('设备未连接，请先连接鼠标');
    for (const op of ops) {
      const { action, args = [] } = op;
      const builder = EXEC_ACTIONS[action];
      if (!builder) throw new Error(`未知操作: ${action}`);
      device.sendFeatureReport(builder(...args));
      await sleep(op.delay ?? 200);
    }
    return true;
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
    for (let i = 0; i < 10; i++) {
      device.sendFeatureReport(P.buildMacroBlock(10, i, slot));
      await sleep(80);
      device.sendReport(bytes.slice(i * 32, i * 32 + 32));
      await sleep(80);
    }
    return true;
  });
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
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (device) device.close();
  device = null;
  if (process.platform !== 'darwin') app.quit();
});

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
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, shell } = require('electron');
const hid = require('./hid');
const { createTrayPopover } = require('./tray-popover');
const P = require('../shared/protocol');
const fmt = require('../shared/config-format');
const i18n = require('../shared/i18n');

let device = null; // 当前打开的 MouseDevice
let deviceInfo = null; // 0x8F 型号信息（parseModelInfo 结果），连接时读取
let mainWindow = null;
let tray = null; // 托盘图标
let trayPopover = null; // 托盘单击弹出的信息浮层
let trayClickTimer = null; // 区分托盘单击/双击的延时句柄
let batteryLevel = null; // 最近一次读到的电量（托盘显示）
let batteryCharging = false; // 充电中标志（0x89 buf[1] bit7 / 推送 b0 bit7）
let lastPushDpi = null; // 上一次推送的 DPI 索引（用于检测鼠标 DPI 键切换）
let lastPushProfile = null; // 上一次推送的配置序号（用于检测鼠标上的配置切换键）
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
  const s = loadSettings();
  return {
    autoLaunch: !!app.getLoginItemSettings().openAtLogin,
    // 兼容旧键 startMinimized（0.2.1 及更早）
    silentStart: !!(s.silentStart != null ? s.silentStart : s.startMinimized),
    // 界面缩放：'auto' 或倍率字符串（'1' / '1.1' / '1.25' / '1.5'）
    uiScale: typeof s.uiScale === 'string' && s.uiScale ? s.uiScale : 'auto',
  };
}

/** 开机自启：注册表 Run 项；静默启动时附加 --background（启动后只驻留托盘、不弹窗） */
function applyLoginItem() {
  const s = loadSettings();
  const autoLaunch = !!app.getLoginItemSettings().openAtLogin;
  if (autoLaunch) {
    app.setLoginItemSettings({
      openAtLogin: true,
      args: getSettings().silentStart ? ['--background'] : [],
    });
  }
}

function setSettings(patch) {
  const s = loadSettings();
  if (s.silentStart == null && s.startMinimized != null) {
    s.silentStart = s.startMinimized; // 旧配置迁移
    delete s.startMinimized;
  }
  if (patch.autoLaunch != null) {
    app.setLoginItemSettings({ openAtLogin: !!patch.autoLaunch });
  }
  if (patch.silentStart != null) {
    s.silentStart = !!patch.silentStart;
  }
  if (patch.uiScale != null) {
    s.uiScale = String(patch.uiScale);
  }
  saveSettings(s);
  applyLoginItem(); // 两个开关都会影响自启参数，统一同步
  return getSettings();
}

// ── 操作分发表：action → 命令构造器 ──────────────────────────
const EXEC_ACTIONS = {
  // 非 8K 接收器/有线时 2000Hz+ 会被硬件钳制为 1000Hz（实机验证），提前在应用层钳制
  setRate: (hz) => P.buildSetRate(P.clampRate(hz, deviceInfo ? deviceInfo.is8KReceiver : null)),
  setDpi: (index, dpi, flag, color) => P.buildSetResolution(index, P.dpiToHw(dpi), flag || 0, color),
  setDpiLevel: (levels, curIndex) => P.buildSetDpiLevel(levels, curIndex),
  // PAW3950 的 LOD 需按官方 apply 流程做 UI→硬件码旋转（0→2, 1→0, 2→1）
  setLod: (hw) => P.buildSetLod(P.lodToHw(hw, deviceInfo ? deviceInfo.sensor : null)),
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
  // 原样写回 32 位键码（读设备时反解不出来的自定义键）
  setKeyRaw: (index, code32) => P.buildSetKey(index, code32 >>> 0),
  setProfile: (index) => P.buildSetProfile(index),
  setReceiverLed: (mode) => P.buildSetReceiverLed(mode),
};

// ── 读取分发表：readType → { builder, parse } ────────────────
// parse 的 buf 是 hid.js 返回的数据区（8 字节，已剥离 reportId）：
//   buf[0]=命令回显, buf[1..]=参数（实测校准，见 docs/protocol.md §4）
const READ_ACTIONS = {
  rate: {
    build: () => P.buildReadRate(),
    // 0x81：buf[1] = 回报率索引 → Hz
    parse: (buf) => {
      const entry = P.RATE_TABLE.find((r) => r.code === buf[1]);
      return entry ? entry.hz : null;
    },
  },
  resolution: {
    build: (slot) => P.buildReadResolution(slot),
    // 0x82：buf[2..3] = DPI 硬件值（16 位小端）；buf[4..6] = 该档灯色（RGB，全 0 = 未设置）
    parse: (buf) => ({
      dpi: P.hwToDpi(buf[2] | (buf[3] << 8)),
      color: P.bytesToColor(buf),
    }),
  },
  dpiLevel: {
    build: () => P.buildReadDpiLevel(),
    parse: (buf) => ({ levels: buf[1], current: buf[2] }),
  },
  sensor: {
    build: (sub) => P.buildReadSensor(sub),
    // 0x84：buf[2] = 值（1=LOD, 2=波纹, 3=直线, 4=MotionSync, 5=传感器模式）
    parse: (buf) => buf[2],
  },
  misc: {
    build: (sub) => P.buildReadMisc(sub),
    // 0x85：sub1 消抖 buf[2]；sub2 火力键 {loops, interval}；sub3 休眠 16 位
    parse: (buf, sub) => {
      if (sub === 2) return { loops: buf[2], interval: buf[3] };
      if (sub === 3) return buf[2] | (buf[3] << 8);
      return buf[2];
    },
  },
  receiverLed: {
    build: () => P.buildReadReceiverLed(),
    parse: (buf) => buf[1],
  },
  // 0x86,9：当前配置序号在 buf[2]（实机验证：写 [6,9,n] 后回读即 n）
  profileIndex: {
    build: () => P.buildReadKey(9),
    parse: (buf) => buf[2],
  },
  modelInfo: {
    build: () => P.buildReadModelInfo(),
    parse: (buf) => {
      const info = P.parseModelInfo(buf, device ? device.isWireless : false);
      if (!info) throw new Error('型号信息解析失败');
      return info;
    },
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

// ── 电量读取 ─────────────────────────────────────────────
/**
 * 读一次电量。Feature Report 9 数据区固定 8 字节（HID 描述符确认），
 * 因此不能按 64 字节读「电压字段」——超长读取在 Windows HidD_GetFeature 下
 * 会失败或返回填充数据（此前电量读不准的根因）。
 * 响应（剥离 reportId）：buf[0]=0x89 回显, buf[1]=电量 0-100（>128 表充电中，减 128）。
 * 返回 { level, charging } | null。
 */
async function readBatteryValue() {
  if (!device) return null;
  device.sendFeatureReport(P.buildReadBattery());
  await sleep(50);
  const buf = device.getFeatureReport(P.REPORT_DATA_LEN);
  if (buf[0] !== 0x89) return null;
  const raw = buf[1];
  const charging = raw > 100;
  const level = charging ? raw - 128 : raw;
  if (level < 0 || level > 100) return null;
  // 设备休眠时可能回显 0x89 但数据区全 0 —— 真实电量读到 0 的情况不存在（0% 已关机），
  // 视为无效读取，避免 UI 误显示成红色的 0%。
  if (level === 0) return null;
  return { level, charging };
}

/**
 * 连接后读取 0x8F 型号信息（型号/接收器类型/传感器）。
 * 失败不阻塞连接（保持旧行为：无 deviceInfo 时 LOD 直接映射、回报率不钳制）。
 */
async function readDeviceInfo() {
  if (!device) return null;
  try {
    device.sendFeatureReport(P.buildReadModelInfo());
    await sleep(50);
    const buf = device.getFeatureReport(P.REPORT_DATA_LEN);
    return P.parseModelInfo(buf, device.isWireless);
  } catch (_) {
    return null;
  }
}

/**
 * 一次读出鼠标当前这整套配置（连接时对齐 UI 用）。
 *
 * 背景：5 个「板载配置」由 PC 端保存——实机验证（2026-11-15 G24）把 [6,9,idx]
 * 依次写到 0..5，DPI/键位/回报率/休眠回读完全一致，只有序号标记变化，
 * 说明硬件只有 1 份配置。因此「读配置」读的就是当前生效的这一份。
 *
 * 单项读失败只把该字段置 null（部分固件不回某些子项），不影响整体。
 */
async function readConfigSnapshot(dev) {
  const read = async (bytes, wait = 45) => {
    dev.sendFeatureReport(bytes);
    await sleep(wait);
    return Buffer.from(dev.getFeatureReport(P.REPORT_DATA_LEN));
  };
  const opt = async (bytes, fn, wait) => {
    try {
      const buf = await read(bytes, wait);
      return buf[0] === bytes[0] ? fn(buf) : null;
    } catch (_) {
      return null;
    }
  };

  const sensor = deviceInfo ? deviceInfo.sensor : null;
  const snap = {
    profileIndex: null,
    levels: null,
    current: null,
    slots: [], // [{ dpi, color }]
    rate: null,
    lod: null, // UI 索引（已按传感器反查）
    ripple: null,
    angleSnap: null,
    motionSync: null,
    sensorMode: null,
    debounce: null,
    sleepTime: null,
    buttons: [], // 每个按键的 32 位键码
    receiverLed: null,
  };

  snap.profileIndex = await opt(P.buildReadKey(9), (b) => b[2]);

  const dpiLevel = await opt(P.buildReadDpiLevel(), (b) => ({ levels: b[1], current: b[2] }));
  if (dpiLevel) {
    snap.levels = Math.min(Math.max(dpiLevel.levels, 1), 6);
    snap.current = Math.min(Math.max(dpiLevel.current, 0), snap.levels - 1);
  }
  // 档位数读不到时按 6 档探一遍（0x82 对任意 slot 都会回值）
  for (let i = 0; i < (snap.levels || 6); i++) {
    const slot = await opt(P.buildReadResolution(i), (b) => ({
      dpi: P.hwToDpi(b[2] | (b[3] << 8)),
      color: P.bytesToColor(b),
    }));
    if (slot) snap.slots.push(slot);
  }

  snap.rate = await opt(P.buildReadRate(), (b) => {
    const entry = P.RATE_TABLE.find((r) => r.code === b[1]);
    return entry ? entry.hz : null;
  });
  const lodHw = await opt(P.buildReadSensor(1), (b) => b[2]);
  snap.lod = lodHw == null ? null : P.lodFromHw(lodHw, sensor);
  snap.ripple = await opt(P.buildReadSensor(2), (b) => b[2] === 1);
  snap.angleSnap = await opt(P.buildReadSensor(3), (b) => b[2] === 1);
  snap.motionSync = await opt(P.buildReadSensor(4), (b) => b[2] === 1);
  snap.sensorMode = await opt(P.buildReadSensor(5), (b) => b[2]);
  snap.debounce = await opt(P.buildReadMisc(1), (b) => b[2]);
  snap.sleepTime = await opt(P.buildReadMisc(3), (b) => P.nearestSleepStep(b[2] | (b[3] << 8)));

  for (let i = 0; i < 6; i++) {
    const code = await opt(P.buildReadKey(i), (b) => ((b[5] << 24) | (b[4] << 16) | (b[3] << 8) | b[2]) >>> 0);
    if (code != null) snap.buttons.push(code);
  }

  if (deviceInfo && deviceInfo.is8KReceiver) {
    snap.receiverLed = await opt(P.buildReadReceiverLed(), (b) => b[1]);
  }
  return snap;
}

function deviceState() {  return device
    ? {
        opened: true,
        productId: device.productId,
        isWireless: device.isWireless,
        path: device.path,
        modelInfo: deviceInfo, // { model, modelCode, is8KReceiver, sensor } | null
      }
    : { opened: false };
}

function getConstants() {
  return {
    rateTable: P.RATE_TABLE,
    lodTable: P.LOD_TABLE,
    ledModeTable: P.LED_MODE_TABLE,
    sleepSteps: P.SLEEP_STEPS,
    profileCount: P.PROFILE_COUNT,
    mouseKeys: Object.keys(P.MOUSE_KEYS),
    mediaKeys: Object.keys(P.MEDIA_KEYS),
    // 反向查表用（读设备时把 32 位键码还原成界面选项）
    mouseKeyCodes: P.MOUSE_KEYS,
    mediaKeyCodes: P.MEDIA_KEYS,
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

// ── 设备断连处理 ───────────────────────────────────────────
/** node-hid 在设备拔出/接收器掉线时的错误特征（hid_read_timeout / GetOverlappedResult 0x48F / 0x2） */
function isDeviceGoneError(e) {
  const m = String((e && e.message) || e || '');
  return /hid_read_timeout|GetOverlappedResult|0x0000048F|0x48F|not connected|device not found|cannot open device|0x00000002|HidD_/i.test(m);
}

/**
 * 设备拔出/掉线：清理状态、托盘复位、通知渲染层回到未连接。
 * @param err          底层错误
 * @param sourceDevice 触发错误的具体设备实例；只有它仍是当前设备时才处理，
 *                     避免旧句柄的迟到错误把刚建立的新连接误清掉
 */
function handleDeviceGone(err, sourceDevice) {
  if (!device) return; // 已处理过，避免重复
  if (sourceDevice && sourceDevice !== device) return; // 旧实例的迟到错误，忽略
  console.warn('[hid] 设备已断开:', String((err && err.message) || err || ''));
  const dead = device;
  device = null; // 先置空，防止重入时误伤新连接
  try {
    dead.close();
  } catch (_) {
    /* 句柄可能已失效 */
  }
  deviceInfo = null;
  lastPushDpi = null;
  lastPushProfile = null;
  hid.invalidateCache(); // 重新插上后接口路径可能变化
  resetQuickStatus();
  updateTrayBattery(null);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('device:disconnected');
  }
}

/**
 * HID 通道串行队列。
 *
 * Feature Report 是「发命令 → 等 → 读回」的三段序列，且读写共用同一条通道：
 * 两路操作并发时，后发的命令会顶掉前一条的响应，各自读到对方的回包（连接时
 * readConfig 与电量轮询/浮层读撞在一起就会读到别的档位的值）。因此所有设备操作
 * 都进这条队列，保证任意时刻只有一个序列在跑。
 */
let ioQueue = Promise.resolve();
function withIo(fn) {
  const run = ioQueue.then(fn, fn); // 前一次失败也要继续，否则队列会永久卡死
  ioQueue = run.then(() => {}, () => {});
  return run;
}

/**
 * 统一的设备操作包装：未连接报错；底层报设备不存在时转为断连处理 + 友好提示。
 * 走串行队列，避免与电量轮询/浮层读取/其它写操作交错。
 */
async function withDevice(fn) {
  if (!device) throw new Error('设备未连接，请先连接鼠标');
  return withIo(async () => {
    const dev = device;
    if (!dev) throw new Error('设备未连接，请先连接鼠标');
    try {
      return await fn(dev);
    } catch (e) {
      if (isDeviceGoneError(e)) {
        handleDeviceGone(e, dev);
        throw new Error('鼠标已断开（被拔出或接收器掉线），请重新连接');
      }
      throw e;
    }
  });
}

// ── IPC 注册 ────────────────────────────────────────────────
function registerIpc() {
  ipcMain.handle('mouse:list', () => hid.listDevicesAsync());

  ipcMain.handle('mouse:open', async (_e, pathArg) => {
    // 打开也进队列：设备切换期间不能让轮询/浮层读插进来（会读到旧句柄或顶掉响应）
    const opened = await withIo(async () => {
      if (device) device.close();
      const dev = await hid.openDevice(pathArg); // 失败会自动重新枚举重试一次（设备切换模式后路径会变）
      device = dev;
      return dev;
    });
    opened.onError((e) => handleDeviceGone(e, opened)); // 拔出/接收器掉线：仅当前设备才处理
    deviceInfo = await withIo(() => readDeviceInfo()); // 连接即识别型号/传感器/8K 接收器（失败为 null）
    lastPushDpi = null; // 新连接重新建立推送基线（避免拿上次会话的索引做比较）
    lastPushProfile = null;
    // 监听设备主动上报（官方电量的主通道）：电量/充电/回报率/DPI 变化时推送
    opened.onData((buf) => {
      const s = P.parseStatusPush(buf);
      if (!s) return;
      if (s.power !== batteryLevel || s.charging !== batteryCharging) {
        updateTrayBattery(s.power, s.charging);
      }
      if (mainWindow) {
        mainWindow.webContents.send('battery:update', { level: s.power, charging: s.charging });
      }
      // 浮层的 DPI/回报率/配置跟着推送走；换了档位要补读该档的 DPI 数值
      if (s.dpiIndex !== quick.dpiIndex) {
        quick.dpiIndex = s.dpiIndex;
        refreshQuickStatus();
      }
      if (s.rate != null) quick.rate = s.rate;
      quick.profile = s.profileIndex;
      broadcastTrayStatus();
      // DPI 键切换档位时弹提示（档位 + 回报率 + 电量）
      if (lastPushDpi != null && s.dpiIndex !== lastPushDpi) {
        notifyDpiSwitch(s);
      }
      lastPushDpi = s.dpiIndex;
      // 鼠标上的配置切换键：硬件只改序号标记，真正的配置由渲染层把预设灌进去
      if (s.profileIndex !== lastPushProfile) {
        const changed = lastPushProfile != null;
        lastPushProfile = s.profileIndex;
        if (changed && mainWindow) {
          mainWindow.webContents.send('profile:update', s.profileIndex);
        }
      }
    });
    pollBattery(); // 连接后立即读一次电量更新托盘（不等 60s 轮询）
    refreshQuickStatus(); // 浮层用的 DPI/回报率/配置（后台补读，不阻塞连接返回）
    return deviceState();
  });

  ipcMain.handle('mouse:close', () => withIo(async () => {
    if (device) device.close(); // 排队执行：别在别的读序列跑到一半时关句柄
    device = null;
    deviceInfo = null;
    lastPushDpi = null;
    lastPushProfile = null;
    hid.invalidateCache(); // 断开后设备可能已换模式，下次连接必须重新枚举
    resetQuickStatus();
    updateTrayBattery(null); // 托盘电量归零为「未连接」
    return deviceState();
  }));

  ipcMain.handle('mouse:state', () => deviceState());
  ipcMain.handle('mouse:constants', () => getConstants());

  ipcMain.handle('mouse:exec', async (_e, action, ...args) => {
    const builder = EXEC_ACTIONS[action];
    if (!builder) throw new Error(`未知操作: ${action}`);
    const cmdBytes = builder(...args);
    writing = true;
    try {
      return await withDevice((dev) => {
        dev.sendFeatureReport(cmdBytes);
        return true;
      });
    } finally {
      writing = false;
    }
  });

  ipcMain.handle('mouse:read', async (_e, readType, ...args) => {
    if (readType === 'battery') {
      const val = await withDevice(() => readBatteryValue());
      if (val == null) throw new Error('设备未响应（可能处于休眠状态）');
      updateTrayBattery(val.level, val.charging); // 手动刷新同步托盘
      return val; // { level, charging }
    }
    const def = READ_ACTIONS[readType];
    if (!def) throw new Error(`未知读取: ${readType}`);
    const cmdBytes = def.build(...args);
    return withDevice(async (dev) => {
      dev.sendFeatureReport(cmdBytes);
      await sleep(50);
      const buf = dev.getFeatureReport(P.REPORT_DATA_LEN);
      // 设备休眠/无响应时返回全 0（buf[0] 无命令回显），视为无效读取，避免解析出错误值
      if (buf[0] !== cmdBytes[0]) {
        throw new Error('设备未响应（可能处于休眠状态）');
      }
      return def.parse(buf, ...args);
    });
  });

  // 一次性读出整套配置（连接/切换配置时对齐 UI，比逐条 IPC 快得多）
  ipcMain.handle('mouse:readConfig', () => withDevice(async (dev) => {
    const snap = await readConfigSnapshot(dev);
    // 顺带把配置序号同步给托盘浮层（省掉单独读 0x86,9 的那条命令）
    if (snap && snap.profileIndex != null) {
      quick.profile = snap.profileIndex;
      broadcastTrayStatus();
    }
    return snap;
  }));

  // 批量应用：按协议 apply 流程顺序执行一组操作（带间隔）
  ipcMain.handle('mouse:apply', async (_e, ops) => {
    writing = true;
    try {
      return await withDevice(async (dev) => {
        for (const op of ops) {
          const { action, args = [] } = op;
          const builder = EXEC_ACTIONS[action];
          if (!builder) throw new Error(`未知操作: ${action}`);
          dev.sendFeatureReport(builder(...args));
          await sleep(op.delay ?? 200);
        }
        return true;
      });
    } finally {
      writing = false;
    }
  });

  // 宏上传：编码 320 字节后分 10 块，每块 feature report 准备 + output report 传数据
  ipcMain.handle('mouse:uploadMacro', async (_e, macro) => {
    if (macro == null || typeof macro.slot !== 'number') {
      throw new Error('宏数据无效');
    }
    if (macro.uid == null) macro.uid = Date.now() >>> 0;
    const bytes = P.encodeMacro(macro);
    const slot = macro.slot & 0xff;
    writing = true;
    try {
      return await withDevice(async (dev) => {
        for (let i = 0; i < 10; i++) {
          dev.sendFeatureReport(P.buildMacroBlock(10, i, slot));
          await sleep(80);
          dev.sendReport(bytes.slice(i * 32, i * 32 + 32));
          await sleep(80);
        }
        return true;
      });
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

  // ── 托盘信息浮层 ────────────────────────────────────────
  // 面板打开时先拿缓存立即渲染，再触发一次实时读取（慢约 200ms，回来覆盖）
  ipcMain.handle('tray:status', () => trayStatus());
  ipcMain.handle('tray:refresh', async () => {
    await refreshQuickStatus();
    return trayStatus();
  });
  ipcMain.handle('tray:hidePopover', () => {
    if (trayPopover) trayPopover.hide();
    return true;
  });
  ipcMain.handle('tray:openMain', () => {
    if (trayPopover) trayPopover.hide();
    showMainWindow();
    return true;
  });

  // 设置（开机自启 / 启动后台保留）
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, patch) => setSettings(patch || {}));

  // 自绘标题栏的窗口控制
  ipcMain.handle('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => {
    if (mainWindow) mainWindow.close(); // 走既有逻辑：隐藏到托盘
  });
  ipcMain.handle('window:isMaximized', () => (mainWindow ? mainWindow.isMaximized() : false));

  // 应用信息 / 外链（仅允许 https，防止渲染进程被注入后调用任意协议）
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    homepage: 'https://github.com/HeHaoren/incott-mouse-app',
  }));
  ipcMain.handle('app:openExternal', async (_e, url) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
      throw new Error('只允许打开 https 链接');
    }
    await shell.openExternal(url);
    return true;
  });
  // 关于（Windows 去掉了原生菜单栏，这里补回入口）
  ipcMain.handle('app:about', async () => {
    const { dialog } = require('electron');
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: i18n.t('menuAbout'),
      message: `Incott Mouse Driver v${app.getVersion()}`,
      detail: `${i18n.t('aboutText')}\n\nhttps://github.com/HeHaoren/incott-mouse-app`,
      buttons: ['OK'],
      noLink: true,
    });
    return true;
  });

  // ── 配置 / 宏 导入导出（官方 .ict / .icm 格式）─────────────
  ipcMain.handle('config:exportProfile', async (_e, profileData) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: i18n.t('exportConfig'),
      defaultPath: 'incott-profile.ict',
      filters: [{ name: 'Incott Profile', extensions: ['ict'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, fmt.exportProfile(profileData), 'utf8');
    return { canceled: false, filePath };
  });

  ipcMain.handle('config:importProfile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: i18n.t('importConfig'),
      properties: ['openFile'],
      filters: [{ name: 'Incott Profile', extensions: ['ict'] }],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    const profile = fmt.importProfile(fs.readFileSync(filePaths[0], 'utf8'));
    if (!profile) throw new Error('不是有效的 .ict 配置文件（magic 校验失败）');
    return { canceled: false, profile };
  });

  ipcMain.handle('config:exportMacros', async (_e, macros) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: i18n.t('exportMacroFile'),
      defaultPath: 'incott-macros.icm',
      filters: [{ name: 'Incott Macro', extensions: ['icm'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    const text = fmt.exportMacros(macros);
    if (!text) throw new Error('没有可导出的宏（所有槽位均为空）');
    fs.writeFileSync(filePath, text, 'utf8');
    return { canceled: false, filePath };
  });

  ipcMain.handle('config:importMacros', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: i18n.t('importMacroFile'),
      properties: ['openFile'],
      filters: [{ name: 'Incott Macro', extensions: ['icm'] }],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    const macros = fmt.importMacros(fs.readFileSync(filePaths[0], 'utf8'));
    if (!macros.length) throw new Error('文件中没有有效的宏（magic 校验失败）');
    return { canceled: false, macros };
  });
}

/** 构建应用菜单（随语言切换重建）
 *  Windows 上不挂菜单栏：语言切换、关于、退出在界面和托盘里都有，
 *  原生菜单条会在顶部多出一条灰色横栏，破坏一体化外观（macOS 保留标准菜单）。 */
function buildMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
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
  if (trayPopover) trayPopover.broadcast('i18n:changed', lang); // 浮层文案跟着切
}

// ── 托盘与后台轮询 ─────────────────────────────────────────
// 托盘单击要等这么久才弹出，用来区分「单击 → 浮层」和「双击 → 主窗口」
const TRAY_CLICK_DELAY = 200;

// 托盘浮层的轻量状态缓存：面板要显示 DPI 数值/回报率/配置序号，
// 这些不在电量推送里全量携带，所以连接时读一次、档位或配置变化时补读，
// 弹面板时先用缓存渲染再后台刷新，避免每次单击都等 HID 往返。
const quick = { dpi: null, dpiIndex: null, levels: null, rate: null, profile: null };
let refreshingQuick = false; // 防止推送密集时并发的补读（会互相打断 feature report）

function resetQuickStatus() {
  quick.dpi = null;
  quick.dpiIndex = null;
  quick.levels = null;
  quick.rate = null;
  quick.profile = null;
}

function trayStatus() {
  return {
    connected: !!device,
    name: deviceInfo
      ? [deviceInfo.model, deviceInfo.is8KReceiver ? '8K' : ''].filter(Boolean).join(' ')
      : null,
    wireless: device ? !!device.isWireless : false,
    battery: batteryLevel,
    charging: batteryCharging,
    dpi: quick.dpi,
    dpiIndex: quick.dpiIndex,
    levels: quick.levels,
    rate: quick.rate,
    profile: quick.profile,
    profileCount: P.PROFILE_COUNT,
  };
}

/** 浮层可见时把状态推给它（不可见时什么都不做，省一次 IPC） */
function broadcastTrayStatus() {
  if (trayPopover && trayPopover.isVisible()) trayPopover.sendStatus();
}

/**
 * 读一次 DPI 档位、当前档 DPI、回报率（3 条命令，约 150ms）。
 * 单项读失败保持旧值——面板显示缓存好过显示空白。
 *
 * 注意：这里刻意不读 0x86,9（配置序号）——配置序号由设备推送和连接时的
 * readConfig 快照提供。多一条读命令就多一次与主界面读序列撞车的风险。
 */
async function refreshQuickStatus() {
  if (!device || writing || refreshingQuick) return;
  refreshingQuick = true;
  let dev = null;
  try {
    await withIo(async () => {
      dev = device;
      if (!dev) return;
      const read = async (bytes) => {
        dev.sendFeatureReport(bytes);
        await sleep(45);
        return Buffer.from(dev.getFeatureReport(P.REPORT_DATA_LEN));
      };
      const lv = await read(P.buildReadDpiLevel());
      if (lv[0] === 0x83) {
        quick.levels = Math.min(Math.max(lv[1], 1), 6);
        quick.dpiIndex = Math.min(Math.max(lv[2], 0), quick.levels - 1);
      }
      const res = await read(P.buildReadResolution(quick.dpiIndex == null ? 0 : quick.dpiIndex));
      if (res[0] === 0x02) quick.dpi = P.hwToDpi(res[2] | (res[3] << 8));
      const rate = await read(P.buildReadRate());
      if (rate[0] === 0x01) {
        const entry = P.RATE_TABLE.find((r) => r.code === rate[1]);
        if (entry) quick.rate = entry.hz;
      }
    });
  } catch (e) {
    if (isDeviceGoneError(e)) handleDeviceGone(e, dev);
    return;
  } finally {
    refreshingQuick = false;
  }
  broadcastTrayStatus();
}

// 电量三段配色（对齐官方与界面规则：>60 绿，25~60 黄，≤25 红）
const TRAY_COLORS = {
  default: [0x4d, 0xa3, 0xff], // 蓝（未连接/未知）
  high: [0x3f, 0xb9, 0x50], // 绿
  mid: [0xd2, 0x99, 0x22], // 黄
  low: [0xf8, 0x51, 0x49], // 红
};

function trayColorFor(battery) {
  if (battery == null) return TRAY_COLORS.default;
  if (battery > 60) return TRAY_COLORS.high;
  if (battery > 25) return TRAY_COLORS.mid;
  return TRAY_COLORS.low;
}

function createTrayIcon(color = TRAY_COLORS.default) {
  // 生成 16x16 圆点托盘图标
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d <= 6) {
        const idx = (y * size + x) * 4;
        buf[idx] = color[0]; buf[idx + 1] = color[1]; buf[idx + 2] = color[2]; buf[idx + 3] = 0xff;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function showMainWindow() {
  if (trayPopover) trayPopover.hide(); // 打开主窗口时收起浮层
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
  // 电量行常驻：连接后显示百分比（充电中带 ⚡），未连接时提示（右键菜单的简易状态框）
  const batteryText = batteryLevel != null
    ? `${batteryLevel}%${batteryCharging ? '⚡' : ''}`
    : t('notConnected');
  items.push({ label: `${t('batteryLabel')}: ${batteryText}`, enabled: false });
  items.push({ type: 'separator' });
  items.push({ label: t('menuQuit'), click: () => { quitting = true; app.quit(); } });
  return Menu.buildFromTemplate(items);
}

function updateTrayBattery(battery, charging) {
  batteryLevel = battery;
  if (charging != null) batteryCharging = charging;
  if (battery == null) batteryCharging = false;
  if (!tray) return;
  tray.setImage(createTrayIcon(trayColorFor(battery))); // 图标颜色随电量档位变化
  const batteryText = battery != null
    ? `${battery}%${batteryCharging ? '⚡' : ''}`
    : i18n.t('notConnected');
  tray.setToolTip(`Incott Mouse Driver — ${i18n.t('batteryLabel')} ${batteryText}`);
  tray.setContextMenu(buildTrayMenu());
  broadcastTrayStatus();
}

async function pollBattery() {
  if (!device || writing) return; // 未连接或正在写，跳过本次
  try {
    const val = await withIo(() => readBatteryValue()); // 走串行队列，别和界面读撞车
    if (val != null) updateTrayBattery(val.level, val.charging);
  } catch (e) {
    // 设备拔出/接收器掉线 → 更新为未连接，不弹异常；休眠则忽略本次，下次重试
    if (isDeviceGoneError(e)) handleDeviceGone(e);
  }
}

/**
 * DPI 键切换提示：窗口可见时发 toast 给界面，否则走 Windows 托盘气泡。
 * 文案：已切换到 DPI 第 n 档 · 8000Hz · 电量 72%⚡
 */
function notifyDpiSwitch(s) {
  const parts = [i18n.t('dpiSwitchToast').replace('{n}', s.dpiIndex + 1)];
  if (s.rate) parts.push(`${s.rate}Hz`);
  parts.push(`${i18n.t('batteryLabel')} ${s.power}%${s.charging ? '⚡' : ''}`);
  const text = parts.join(' · ');
  if (mainWindow && mainWindow.isVisible()) {
    mainWindow.webContents.send('toast', text);
  } else if (tray) {
    try {
      tray.displayBalloon({ icon: createTrayIcon(), title: 'Incott Mouse Driver', content: text });
    } catch (_) {
      /* 系统通知被关闭时静默 */
    }
  }
}

function startBatteryPolling() {
  if (batteryTimer) return;
  batteryTimer = setInterval(pollBattery, 60000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 580,
    title: 'Incott Mouse Driver',
    // 全自绘窗口：无原生边框 + 透明底，圆角与描边都由渲染层画
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false, // 透明窗口下 DWM 不画阴影，改由 CSS 描边处理
    thickFrame: true, // 保留边缘拖拽缩放与 Aero Snap
    roundedCorners: false, // Windows 11 上也不让系统再叠一层圆角
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // 允许 preload require 本地模块（shared/i18n）
      backgroundThrottling: false, // 窗口被遮挡时不冻结渲染（电量/状态推送要持续更新）
    },
  });

  // 最大化状态同步给渲染层（自绘标题栏按钮图标要切换）
  const sendMaximized = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaximized);
  mainWindow.on('unmaximize', sendMaximized);

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

// 兜底：node-hid 的读线程可能在设备拔出的瞬间抛异常（HID device 的 error 事件之外的路径），
// 这里拦下「设备已断开」类异常转为状态更新，避免弹出未捕获异常对话框。
process.on('uncaughtException', (e) => {
  if (isDeviceGoneError(e)) {
    handleDeviceGone(e);
    return;
  }
  console.error('[main] 未捕获异常:', e);
});

/**
 * 卸载流程（安装器写入的 UninstallString 会带 --uninstall 调起本程序）。
 * 装好的目录里只有这个 exe，所以由它自己删自己：先清快捷方式与注册表，
 * 再拉起一个 detached 的 cmd 等本进程退出后整目录删除。
 */
async function runUninstall() {
  const dir = path.dirname(app.getPath('exe'));
  const res = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['卸载', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: '卸载 Incott Mouse Driver',
    message: '确定要卸载 Incott 鼠标驱动吗？',
    detail: '将删除程序文件和快捷方式。鼠标里的板载配置与已导出的配置文件不受影响。',
  });
  if (res.response !== 0) {
    app.exit(0);
    return;
  }

  // 关掉其它正在运行的实例（保留自己，否则文件一直被占用）
  try {
    spawn('taskkill', ['/F', '/FI', `PID ne ${process.pid}`, '/IM', 'Incott Mouse Driver.exe'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch (_) { /* 忽略 */ }

  // 快捷方式
  const lnks = [
    path.join(app.getPath('desktop'), 'Incott Mouse Driver.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Incott Mouse Driver.lnk'),
  ];
  for (const p of lnks) {
    try {
      fs.rmSync(p, { force: true });
    } catch (_) { /* 忽略 */ }
  }

  // 卸载注册表项（reg.exe 被安全策略拦掉时静默跳过）
  try {
    spawn('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.incott.mouseapp', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch (_) { /* 忽略 */ }

  // 本进程退出后再删目录（自身 exe 被占用，必须先退出）
  try {
    spawn('cmd.exe', ['/c', `ping -n 4 127.0.0.1 >nul & rmdir /s /q "${dir}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch (_) { /* 忽略 */ }

  app.exit(0);
}

app.whenReady().then(async () => {
  if (process.argv.includes('--uninstall')) {
    await runUninstall();
    return;
  }
  registerIpc();
  createWindow();
  // 只有开机自启（注册表 Run 带 --background）才静默挂托盘；手动运行 exe 总是弹窗
  if (process.argv.includes('--background')) {
    mainWindow.hide();
  }
  buildMenu(); // 应用菜单（中英文）
  hid.prewarm(); // 后台预枚举设备（不阻塞，连接时秒开）
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Incott Mouse Driver');
  tray.setContextMenu(buildTrayMenu());
  trayPopover = createTrayPopover({ getStatus: trayStatus });
  // 稍后预热浮层窗口（只创建不显示），首次单击不用等页面加载
  setTimeout(() => {
    if (trayPopover) trayPopover.warmup();
  }, 1500);
  // 单击：弹出信息浮层（再单击收起）；双击：打开主窗口。
  // Windows 上双击会先送来 click 事件，所以单击要压一个延时等第二次点击，
  // 收到 double-click 时立即取消，避免「双击时先闪一下浮层」。
  tray.on('click', () => {
    if (trayClickTimer) {
      clearTimeout(trayClickTimer);
      trayClickTimer = null;
      return;
    }
    trayClickTimer = setTimeout(() => {
      trayClickTimer = null;
      if (!trayPopover) return;
      trayPopover.toggle(tray);
      // 弹出后补一次实时读取：缓存可能是在官方驱动/鼠标按键改过之后留下的
      if (trayPopover.isVisible()) refreshQuickStatus();
    }, TRAY_CLICK_DELAY);
  });
  tray.on('double-click', () => {
    if (trayClickTimer) {
      clearTimeout(trayClickTimer);
      trayClickTimer = null;
    }
    showMainWindow();
  });
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
  if (trayClickTimer) clearTimeout(trayClickTimer);
  trayClickTimer = null;
  if (trayPopover) trayPopover.destroy();
  trayPopover = null;
});

app.on('window-all-closed', () => {
  // 关窗仅隐藏到托盘（见 close 拦截），不退出；真正退出走托盘「退出」/应用菜单 quit
});

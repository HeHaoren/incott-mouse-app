/**
 * Incott 鼠标 HID 协议层（纯函数 + 常量）
 *
 * 所有命令为 8 字节 Feature Report，report ID = 9。
 * 本模块只负责「构造命令字节」，不涉及任何 I/O —— 因此可脱离设备做单元测试。
 * 协议细节见 docs/protocol.md。
 */

'use strict';

// ── 设备常量 ──────────────────────────────────────────────
const VID = 0x093a; // PixArt 原相
const PID_WIRED = 0x622c; // 有线
const PID_WIRELESS = 0x522c; // 无线
const REPORT_ID = 9;
const REPORT_DATA_LEN = 8; // 命令数据区长度（不含 reportId）
const USAGE_PAGE = 0xff05;
const USAGE = 0x0001;

// ── 传感器 ────────────────────────────────────────────────
const SENSOR = {
  PAW3395: 0x3395, // 最大 32000 DPI
  PAW3950: 0x3950, // 最大 45000 DPI
};

// ── 轮询率 ────────────────────────────────────────────────
const RATE_TABLE = [
  { hz: 1000, code: 0 },
  { hz: 500, code: 1 },
  { hz: 250, code: 2 },
  { hz: 125, code: 3 },
  { hz: 8000, code: 4 },
  { hz: 4000, code: 5 },
  { hz: 2000, code: 6 },
];

// ── LOD ───────────────────────────────────────────────────
const LOD_TABLE = [0.7, 1, 2]; // UI 值（mm），硬件码即索引 0/1/2

// ── 按键矩阵（byte 1 = 矩阵位置）───────────────────────────
const KEY_MATRIX = {
  LEFT: 0,
  RIGHT: 1,
  MIDDLE: 2,
  BACK: 3,
  FORWARD: 4,
  DPI: 5,
};

// ── 鼠标键码（32 位）──────────────────────────────────────
const MOUSE_KEYS = {
  LEFT: 0x00f00001,
  RIGHT: 0x00f10001,
  MIDDLE: 0x00f20001,
  FORWARD: 0x00f40001,
  BACK: 0x00f30001,
  DPI_LOOP: 0x00030007,
  DPI_INC: 0x00010007,
  DPI_DEC: 0x00020007,
  PROFILE: 61706, // 0xF10A
  FIRE: 0x0218f00a,
  DISABLED: 0,
};

// ── 多媒体键码（32 位，格式 0xXXYY0003）────────────────────
const MEDIA_KEYS = {
  PLAYER: 0x01830003,
  PLAY_PAUSE: 0x00cd0003,
  STOP: 0x00b70003,
  PREVIOUS: 0x00b60003,
  NEXT: 0x00b50003,
  VOL_INC: 0x00e90003,
  VOL_DEC: 0x00ea0003,
  MUTE: 0x00e20003,
  EMAIL: 0x018a0003,
  CALCULATOR: 0x01920003,
  EXPLORER: 0x01940003,
  HOME: 0x02230003,
  REFRESH: 0x02270003,
  FORWARD: 0x02250003,
  BACK: 0x02240003,
  SEARCH: 0x02210003,
};

// ── 修饰键掩码 ─────────────────────────────────────────────
const MODIFIERS = {
  CTRL_L: 1,
  SHIFT_L: 2,
  ALT_L: 4,
  WIN_L: 8,
  CTRL_R: 16,
  SHIFT_R: 32,
  ALT_R: 64,
  WIN_R: 128,
};

// ── HID 键盘键码（标准 HID Usage ID）────────────────────────
const HID_KEY_CODES = {
  KeyA: 0x04, KeyB: 0x05, KeyC: 0x06, KeyD: 0x07, KeyE: 0x08, KeyF: 0x09,
  KeyG: 0x0a, KeyH: 0x0b, KeyI: 0x0c, KeyJ: 0x0d, KeyK: 0x0e, KeyL: 0x0f,
  KeyM: 0x10, KeyN: 0x11, KeyO: 0x12, KeyP: 0x13, KeyQ: 0x14, KeyR: 0x15,
  KeyS: 0x16, KeyT: 0x17, KeyU: 0x18, KeyV: 0x19, KeyW: 0x1a, KeyX: 0x1b,
  KeyY: 0x1c, KeyZ: 0x1d,
  Digit1: 0x1e, Digit2: 0x1f, Digit3: 0x20, Digit4: 0x21, Digit5: 0x22,
  Digit6: 0x23, Digit7: 0x24, Digit8: 0x25, Digit9: 0x26, Digit0: 0x27,
  Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30,
  Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
  Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39,
  F1: 0x3a, F2: 0x3b, F3: 0x3c, F4: 0x3d, F5: 0x3e, F6: 0x3f,
  F7: 0x40, F8: 0x41, F9: 0x42, F10: 0x43, F11: 0x44, F12: 0x45,
  PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49,
  Home: 0x4a, PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
  NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55,
  NumpadSubtract: 0x56, NumpadAdd: 0x57, NumpadEnter: 0x58,
  Numpad1: 0x59, Numpad2: 0x5a, Numpad3: 0x5b, Numpad4: 0x5c,
  Numpad5: 0x5d, Numpad6: 0x5e, Numpad7: 0x5f, Numpad8: 0x60,
  Numpad9: 0x61, Numpad0: 0x62, NumpadDecimal: 0x63, IntlBackslash: 0x64,
  ContextMenu: 0x65, F13: 0x68,
  ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
  ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7,
};

// ── 功能类别（对应网页驱动 fMouse/fKeyboard/fMedia/fJuji）─────
const KEY_TYPE = {
  MOUSE: 1,
  KEYBOARD: 2,
  MEDIA: 3,
  MACRO: 4,
};

// ── DPI 映射 ───────────────────────────────────────────────
/**
 * 实际 DPI → 硬件值：hw = (dpi - 50) / 50
 */
function dpiToHw(dpi) {
  if (dpi < 50) return -1;
  const hw = Math.round((dpi - 50) / 50);
  return hw;
}

/**
 * 硬件值 → 实际 DPI：dpi = 50 + hw * 50
 */
function hwToDpi(hw) {
  return 50 + hw * 50;
}

/**
 * 传感器最大 DPI
 */
function maxDpiForSensor(sensor) {
  return sensor === SENSOR.PAW3950 ? 45000 : 32000;
}

// ── 命令构造（全部返回 8 字节 Buffer）───────────────────────
function cmd(op, p1 = 0, p2 = 0, p3 = 0, p4 = 0, p5 = 0, p6 = 0, p7 = 0) {
  return Buffer.from([op, p1, p2, p3, p4, p5, p6, p7]);
}

/** 轮询率：hz → 8 字节命令 */
function buildSetRate(hz) {
  const entry = RATE_TABLE.find((r) => r.hz === hz);
  if (!entry) throw new RangeError(`不支持的轮询率: ${hz}Hz`);
  return cmd(1, entry.code);
}

/** DPI 档位值：[2, index, dpiHwLow, dpiHwHigh, 0,0,0, flag] */
function buildSetResolution(index, hwValue, flag = 0) {
  if (hwValue < 0 || hwValue > 0xffff) throw new RangeError(`DPI 硬件值越界: ${hwValue}`);
  const lo = hwValue & 0xff;
  const hi = (hwValue >> 8) & 0xff;
  return cmd(2, index, lo, hi, 0, 0, 0, flag);
}

/** DPI 档位切换：[3, levels, curIndex] */
function buildSetDpiLevel(levels, curIndex) {
  return cmd(3, levels, curIndex);
}

/** 传感器高级设置：[4, sub, val] */
function buildSetLod(hw) {
  return cmd(4, 1, hw);
}
function buildSetRipple(on) {
  return cmd(4, 2, on ? 1 : 0);
}
function buildSetAngleSnap(on) {
  return cmd(4, 3, on ? 1 : 0);
}
function buildSetMotionSync(on) {
  return cmd(4, 4, on ? 1 : 0);
}
function buildSetSensorMode(mode) {
  return cmd(4, 5, mode);
}

/** 去抖时间：[5,1,t] */
function buildSetDebounce(t) {
  return cmd(5, 1, Math.min(t, 30));
}
/** 火力键：[5,2,lp,t] */
function buildSetFireKey(loop, interval) {
  return cmd(5, 2, Math.min(loop, 3), interval);
}
/** 睡眠时间：[5,3,tL,tH] */
function buildSetSleepTime(t) {
  const v = Math.max(t, 10);
  return cmd(5, 3, v & 0xff, (v >> 8) & 0xff);
}

/** 按键映射：[6, index, k1,k2,k3,k4]（32 位键码小端） */
function buildSetKey(index, code32) {
  const k1 = code32 & 0xff;
  const k2 = (code32 >> 8) & 0xff;
  const k3 = (code32 >> 16) & 0xff;
  const k4 = (code32 >> 24) & 0xff;
  return cmd(6, index, k1, k2, k3, k4);
}

/** Profile 切换：[6,9,index] */
function buildSetProfile(index) {
  return cmd(6, 9, index);
}

/** 宏分块上传（Output Report）：[7, totalBlocks, blockIndex, 32, slotId] */
function buildMacroBlock(totalBlocks, blockIndex, slotId) {
  return cmd(7, totalBlocks, blockIndex, 32, slotId);
}

/** 接收器 LED：[8, mode] */
function buildSetReceiverLed(mode) {
  return cmd(8, mode);
}

/** 读取命令：byte 0 = 命令码，byte 1.. = 参数 */
function buildReadDpiLevel() {
  return cmd(131);
}
function buildReadBattery() {
  return cmd(133, 3);
}
function buildReadKey(index) {
  return cmd(134, index);
}
function buildReadMatchInfo() {
  return cmd(142, 1);
}
function buildReadProfileIndex() {
  return buildReadKey(9);
}

// ── 键码编码 ───────────────────────────────────────────────
/** 鼠标键 → 32 位键码 */
function encodeMouseKey(name) {
  if (!(name in MOUSE_KEYS)) throw new Error(`未知鼠标键: ${name}`);
  return MOUSE_KEYS[name];
}

/** 键盘键（HID 键码 + 可选修饰掩码）→ 32 位键码 */
function encodeKeyboardKey(hidCode, modifierMask = 0) {
  if (modifierMask) {
    return ((hidCode & 0xff) << 16) | ((modifierMask & 0xff) << 8);
  }
  return ((hidCode & 0xff) << 8) | 0x80;
}

/** 多媒体键 → 32 位键码 */
function encodeMediaKey(name) {
  if (!(name in MEDIA_KEYS)) throw new Error(`未知多媒体键: ${name}`);
  return MEDIA_KEYS[name];
}

/** 宏槽位 → 32 位键码：index << 16 | 9 */
function encodeMacroKey(slotIndex) {
  return (slotIndex << 16) | 9;
}

// ── 宏数据编码（320 字节）───────────────────────────────────
/**
 * 编码宏数据为 320 字节 Buffer。
 * @param {object} macro { slot, loopType, cycle, items: [{press, keyCode, delay}] , uid }
 * loopType: 0=按住循环, 1=任意键停止, 2=循环N次
 */
function encodeMacro(macro) {
  const b = Buffer.alloc(320);
  b[0] = macro.slot & 0xff;
  b[1] = macro.loopType;
  b[2] = macro.cycle & 0xff;
  b[3] = (macro.cycle >> 8) & 0xff;

  let k = 4;
  const items = macro.items || [];
  for (const it of items) {
    if (k + 4 > 288) break; // 项区最多到 288
    b[k] = (it.press ? 0 : 128) | 1;
    b[k + 1] = it.keyCode & 0xff;
    b[k + 2] = it.delay & 0xff;
    b[k + 3] = (it.delay >> 8) & 0xff;
    k += 4;
  }

  // "Macro"+编号 标记
  b[288] = 77; // M
  b[289] = 97; // a
  b[290] = 99; // c
  b[291] = 114; // r
  b[292] = 111; // o
  b[293] = 49 + macro.slot; // '1' + slot

  const size = (items.length + 1) * 4 + 128;
  b[304] = size & 0xff;
  b[305] = (size >> 8) & 0xff;
  b[306] = (size >> 16) & 0xff;
  b[307] = (size >> 24) & 0xff;
  b[308] = 16;
  b[309] = 0;
  b[310] = 232; // 0xE8
  b[311] = 232;
  b[312] = macro.uid & 0xff;
  b[313] = (macro.uid >> 8) & 0xff;
  b[314] = (macro.uid >> 16) & 0xff;
  b[315] = (macro.uid >> 24) & 0xff;
  const len = items.length * 2;
  b[316] = len & 0xff;
  b[317] = (len >> 8) & 0xff;
  b[318] = items.length & 0xff;
  b[319] = 0;
  return b;
}

module.exports = {
  // 常量
  VID,
  PID_WIRED,
  PID_WIRELESS,
  REPORT_ID,
  REPORT_DATA_LEN,
  USAGE_PAGE,
  USAGE,
  SENSOR,
  RATE_TABLE,
  LOD_TABLE,
  KEY_MATRIX,
  MOUSE_KEYS,
  MEDIA_KEYS,
  MODIFIERS,
  HID_KEY_CODES,
  KEY_TYPE,
  // DPI 映射
  dpiToHw,
  hwToDpi,
  maxDpiForSensor,
  // 命令构造
  buildSetRate,
  buildSetResolution,
  buildSetDpiLevel,
  buildSetLod,
  buildSetRipple,
  buildSetAngleSnap,
  buildSetMotionSync,
  buildSetSensorMode,
  buildSetDebounce,
  buildSetFireKey,
  buildSetSleepTime,
  buildSetKey,
  buildSetProfile,
  buildMacroBlock,
  buildSetReceiverLed,
  buildReadDpiLevel,
  buildReadBattery,
  buildReadKey,
  buildReadMatchInfo,
  buildReadProfileIndex,
  // 键码编码
  encodeMouseKey,
  encodeKeyboardKey,
  encodeMediaKey,
  encodeMacroKey,
  // 宏编码
  encodeMacro,
};

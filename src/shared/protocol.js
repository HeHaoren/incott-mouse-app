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
// PAW3950 的 UI→硬件码旋转映射（源自官方网页驱动 apply 流程）：
// UI 0(0.7mm)→hw 2, UI 1(1mm)→hw 0, UI 2(2mm)→hw 1。PAW3395 为直接映射。
const LOD_HW_3950 = [2, 0, 1];

// ── 型号（0x8F 读命令返回 byte 2）─────────────────────────
const MODEL_TABLE = {
  1: 'Ghero',
  2: 'G23',
  3: 'G24',
  6: 'G29',
  8: 'G23V2',
  9: 'FM23',
  14: 'G23V2',
};

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

// ── LOD 映射 ───────────────────────────────────────────────
/**
 * UI LOD 索引 → 硬件码。
 * PAW3950 走旋转映射 [2,0,1]（官方网页驱动 apply 流程原样行为）；
 * 其他传感器（PAW3395/未知）直接映射。
 */
function lodToHw(uiLod, sensor) {
  if (uiLod < 0 || uiLod > 2) throw new RangeError(`LOD 索引越界: ${uiLod}`);
  return sensor === SENSOR.PAW3950 ? LOD_HW_3950[uiLod] : uiLod;
}

// ── 回报率钳制 ─────────────────────────────────────────────
/**
 * 实机验证（Caldis G24 有线）：有线/非 8K 接收器上 2000/4000/8000Hz
 * 会被硬件钳制为 1000Hz。>1000Hz 只在 8K 接收器下可用。
 */
function isRateSupported(hz, is8KReceiver) {
  if (is8KReceiver == null) return true; // 未知时不限制（保持旧行为）
  if (!is8KReceiver && hz > 1000) return false;
  return RATE_TABLE.some((r) => r.hz === hz);
}

/** hz 钳制到当前接收器能力；不支持的档位回落到 1000Hz */
function clampRate(hz, is8KReceiver) {
  if (!RATE_TABLE.some((r) => r.hz === hz)) throw new RangeError(`不支持的轮询率: ${hz}Hz`);
  if (!isRateSupported(hz, is8KReceiver)) return 1000;
  return hz;
}

// ── 型号信息解析（0x8F）────────────────────────────────────
/**
 * 解析 0x8F 回包（已剥离 reportId 的 8 字节数据区）。
 * 布局：buf[0]=0x8F 回显, buf[1]=1(标志), buf[2]=型号码, buf[3]=接收器类型(2=8K),
 *       传感器字节：有线在 buf[4]，无线在 buf[5]；241=PAW3950，否则 PAW3395。
 * 解析失败（非本命令回包/标志不对/未知型号）返回 null。
 */
function parseModelInfo(buf, isWireless) {
  if (!buf || buf.length < 6) return null;
  if (buf[0] !== 0x8f || buf[1] !== 1) return null;
  const modelCode = buf[2];
  const model = MODEL_TABLE[modelCode];
  if (!model) return null;
  const is8KReceiver = buf[3] === 2;
  const sensorByte = buf[isWireless ? 5 : 4];
  const sensor = sensorByte === 241 ? SENSOR.PAW3950 : SENSOR.PAW3395;
  return { modelCode, model, is8KReceiver, sensor };
}

// ── 设备主动上报解析（Input Report，官方 irServer 同源）────
/**
 * 解析鼠标主动推送的状态包（电量/回报率/DPI/板载配置变化时发送）。
 * buf 为剥离 reportId 后的数据区：
 *   buf[0] = 电量 0-100，bit7 (128) = 充电中标志
 *   buf[1] = 低 4 位回报率索引 | 高 4 位当前 DPI 索引
 *   buf[2] = 高 2 位板载配置序号
 * 官方驱动的电量以此推送为准（其 UI 的「电量同步中」就是在等推送）。
 * 无法识别为状态包时返回 null。
 */
function parseStatusPush(buf) {
  if (!buf || buf.length < 3) return null;
  const power = buf[0] & 127;
  if (power > 100) return null; // 电量越界 → 不是状态包
  const rateIdx = buf[1] & 15;
  const rateEntry = rateIdx < RATE_TABLE.length ? RATE_TABLE.find((r) => r.code === rateIdx) : null;
  return {
    power,
    charging: (buf[0] & 128) !== 0,
    rate: rateEntry ? rateEntry.hz : null,
    dpiIndex: (buf[1] & 240) >> 4,
    profileIndex: (buf[2] & 192) >> 6,
  };
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

/**
 * 每档 DPI 灯色在命令 2 的 buf[4..6] 里的字节顺序（实机校准 2026-11-14）。
 * 官方网页驱动这三个字节恒填 0，导致"改颜色不生效"；固件本身是收这三个字节的。
 */
const DPI_COLOR_ORDER = ['r', 'g', 'b']; // buf[4]=r, buf[5]=g, buf[6]=b

/** CSS 颜色（#RRGGBB / #RGB / RGB 整数 0xBBGGRR）→ 三字节灯色数组 */
function colorToBytes(color) {
  const zero = [0, 0, 0];
  if (color == null) return zero;
  let r = 0;
  let g = 0;
  let b = 0;
  if (typeof color === 'number') {
    // .ict 的 dpicolor 是 0xBBGGRR 整数
    r = color & 0xff;
    g = (color >> 8) & 0xff;
    b = (color >> 16) & 0xff;
  } else {
    const hex = String(color).trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(hex)) return zero;
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    const n = parseInt(full, 16);
    r = (n >> 16) & 0xff;
    g = (n >> 8) & 0xff;
    b = n & 0xff;
  }
  const ch = { r, g, b };
  return DPI_COLOR_ORDER.map((k) => ch[k]);
}

/** 从 0x82 回读的 buf 里还原灯色 → '#RRGGBB'；全 0 表示未设置（固件默认）*/
function bytesToColor(buf) {
  const ch = {};
  DPI_COLOR_ORDER.forEach((k, i) => {
    ch[k] = buf[4 + i] & 0xff;
  });
  return '#' + [ch.r, ch.g, ch.b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** DPI 档位值：[2, index, dpiHwLow, dpiHwHigh, r,g,b, flag] */
function buildSetResolution(index, hwValue, flag = 0, color = null) {
  if (hwValue < 0 || hwValue > 0xffff) throw new RangeError(`DPI 硬件值越界: ${hwValue}`);
  const lo = hwValue & 0xff;
  const hi = (hwValue >> 8) & 0xff;
  const [c4, c5, c6] = colorToBytes(color);
  return cmd(2, index, lo, hi, c4, c5, c6, flag);
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

/** 接收器 LED 模式表（8K 接收器专用，命令 8；官方 UI 为 3 个选项） */
const LED_MODE_TABLE = [
  { value: 0, key: 'ledRate' }, // 回报率指示
  { value: 1, key: 'ledBattery' }, // 电量指示
  { value: 2, key: 'ledLow' }, // 仅警告电池
];

/** 接收器 LED：[8, mode]，mode 取 LED_MODE_TABLE 的 value */
function buildSetReceiverLed(mode) {
  if (!LED_MODE_TABLE.some((m) => m.value === mode)) {
    throw new RangeError(`不支持的接收器灯效: ${mode}`);
  }
  return cmd(8, mode);
}

/** 读取命令：byte 0 = 命令码，byte 1.. = 参数。
 *  写命令 0x01~0x08 对应读命令 0x81~0x88（实机验证，见 docs/protocol.md §4），
 *  另有 0x89 状态 / 0x8E 配对 / 0x8F 型号信息三条独立读命令。 */
function buildReadRate() {
  return cmd(0x81);
}
function buildReadResolution(slot) {
  return cmd(0x82, slot);
}
function buildReadDpiLevel() {
  return cmd(131); // 0x83
}
function buildReadSensor(sub) {
  return cmd(0x84, sub);
}
function buildReadMisc(sub) {
  return cmd(0x85, sub);
}
function buildReadReceiverLed() {
  return cmd(0x88);
}
function buildReadModelInfo() {
  return cmd(0x8f); // 143
}
function buildReadBattery() {
  return cmd(0x89); // 读接收器完整状态（电量在响应 buf[1]，见 anuonie 协议）
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
  LED_MODE_TABLE,
  LOD_HW_3950,
  MODEL_TABLE,
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
  // DPI 档位灯色
  DPI_COLOR_ORDER,
  colorToBytes,
  bytesToColor,
  // LOD / 回报率 / 型号
  lodToHw,
  isRateSupported,
  clampRate,
  parseModelInfo,
  parseStatusPush,
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
  buildReadRate,
  buildReadResolution,
  buildReadDpiLevel,
  buildReadSensor,
  buildReadMisc,
  buildReadReceiverLed,
  buildReadModelInfo,
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

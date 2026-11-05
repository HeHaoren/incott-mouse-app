/**
 * 官方网页驱动配置文件格式（.ict 配置 / .icm 宏）的导入导出。
 *
 * 格式与官方网页驱动（StProfile/STMacro）及 oexi 移植版完全兼容：
 *   .ict：`magic:incott_magic102;name:..;key[i]:major,minor,modifer,macro,itemdata;..`
 *         多个配置以 `|||` 连接（本工具导出单个当前配置，导入取第一个）。
 *   .icm：`magic:macro100;name:..;looptype:1~3;item[i]:键名,延迟,true/false;..`
 *         宏库以 `|||` 连接。
 *
 * 注意两套顺序差异：
 * - .ict 的 key[] 是 UI 顺序 [左,右,中,前进,后退,DPI]，本 App state.buttons 是
 *   硬件矩阵顺序 [左,右,中,后退,前进,DPI]（前进/后退互换）。
 * - 官方 looptype 1=按住循环/2=任意键停止/3=循环N次，硬件 loopType 为 0/1/2（差 1）。
 */

'use strict';

const P = require('./protocol');

const MAGIC_PROFILE = 'incott_magic102';
const MAGIC_MACRO = 'macro100';

// ── 鼠标/多媒体功能 minor 码（官方 define 常量）───────────────
const MOUSE_MINOR = {
  LEFT: 1, RIGHT: 2, MIDDLE: 3, FORWARD: 4, BACK: 5,
  DPI_LOOP: 12, DPI_INC: 13, DPI_DEC: 14,
  DISABLED: 15, FIRE: 17, PROFILE: 18,
};
const MINOR_TO_MOUSE = Object.fromEntries(Object.entries(MOUSE_MINOR).map(([k, v]) => [v, k]));

const MEDIA_MINOR = {
  PLAYER: 1, PLAY_PAUSE: 2, STOP: 3, PREVIOUS: 4, NEXT: 5,
  VOL_INC: 6, VOL_DEC: 7, MUTE: 8, EMAIL: 9, CALCULATOR: 10,
  EXPLORER: 11, HOME: 12, REFRESH: 14, FORWARD: 15, BACK: 16, SEARCH: 17,
};
const MINOR_TO_MEDIA = Object.fromEntries(Object.entries(MEDIA_MINOR).map(([k, v]) => [v, k]));

// ── 官方键名表（显示名 ↔ HID 码，与官方 vkPOS 一致）────────────
// [KeyboardEvent.code, 官方显示名]，HID 码取自 protocol.HID_KEY_CODES
const DISPLAY_NAMES = [
  ['KeyA', 'A'], ['KeyB', 'B'], ['KeyC', 'C'], ['KeyD', 'D'], ['KeyE', 'E'],
  ['KeyF', 'F'], ['KeyG', 'G'], ['KeyH', 'H'], ['KeyI', 'I'], ['KeyJ', 'J'],
  ['KeyK', 'K'], ['KeyL', 'L'], ['KeyM', 'M'], ['KeyN', 'N'], ['KeyO', 'O'],
  ['KeyP', 'P'], ['KeyQ', 'Q'], ['KeyR', 'R'], ['KeyS', 'S'], ['KeyT', 'T'],
  ['KeyU', 'U'], ['KeyV', 'V'], ['KeyW', 'W'], ['KeyX', 'X'], ['KeyY', 'Y'],
  ['KeyZ', 'Z'],
  ['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'], ['Digit4', '4'],
  ['Digit5', '5'], ['Digit6', '6'], ['Digit7', '7'], ['Digit8', '8'],
  ['Digit9', '9'], ['Digit0', '0'],
  ['F1', 'F1'], ['F2', 'F2'], ['F3', 'F3'], ['F4', 'F4'], ['F5', 'F5'],
  ['F6', 'F6'], ['F7', 'F7'], ['F8', 'F8'], ['F9', 'F9'], ['F10', 'F10'],
  ['F11', 'F11'], ['F12', 'F12'], ['F13', 'F13'],
  ['Minus', '-'], ['Equal', '='], ['BracketLeft', '['], ['BracketRight', ']'],
  ['Backslash', '|'], ['Semicolon', ';'], ['Quote', "'"], ['Comma', '<'],
  ['Period', '>'], ['Slash', '?'], ['Backquote', '~'],
  ['Backspace', 'Back'], ['Enter', 'Enter'], ['Space', 'Space'],
  ['Escape', 'Esc'], ['Tab', 'Tab'], ['CapsLock', 'CapsLk'],
  ['ContextMenu', 'App'],
  ['ControlLeft', 'Ctrl'], ['ShiftLeft', 'Shift'], ['AltLeft', 'Alt'],
  ['MetaLeft', 'Win'], ['ControlRight', 'RCtrl'], ['ShiftRight', 'RShift'],
  ['AltRight', 'RAlt'], ['MetaRight', 'RWin'],
  ['Pause', 'Pause'], ['ScrollLock', 'ScrLk'], ['Insert', 'Ins'],
  ['Home', 'Home'], ['PageUp', 'PgUp'], ['Delete', 'Del'], ['End', 'End'],
  ['PageDown', 'PgDn'],
  ['ArrowLeft', 'Left'], ['ArrowUp', 'Up'], ['ArrowDown', 'Down'],
  ['ArrowRight', 'Right'],
  ['NumLock', 'NumLk'], ['NumpadEnter', 'NumEnter'], ['NumpadDivide', 'Num/'],
  ['NumpadMultiply', 'Num*'], ['NumpadSubtract', 'Num-'], ['NumpadAdd', 'Num+'],
  ['NumpadDecimal', 'Num.'],
  ['Numpad1', 'Num1'], ['Numpad2', 'Num2'], ['Numpad3', 'Num3'],
  ['Numpad4', 'Num4'], ['Numpad5', 'Num5'], ['Numpad6', 'Num6'],
  ['Numpad7', 'Num7'], ['Numpad8', 'Num8'], ['Numpad9', 'Num9'],
  ['Numpad0', 'Num0'], ['IntlBackslash', 'K45'],
  // 注意：PrintScreen 等官方键表（vkPOS）没有的键不收录——官方导入会整条宏失败
];

// HID 码 ↔ 官方显示名
const HID_TO_DISPLAY = {};
const DISPLAY_TO_HID = {};
for (const [code, display] of DISPLAY_NAMES) {
  const hid = P.HID_KEY_CODES[code];
  if (hid == null) continue;
  HID_TO_DISPLAY[hid] = display;
  if (!(display in DISPLAY_TO_HID)) DISPLAY_TO_HID[display] = hid;
}

/** HID 码 → 官方显示名（宏导出用）；未知返回 null */
function hidToDisplay(hidCode) {
  return HID_TO_DISPLAY[hidCode] || null;
}

/** 官方显示名 → HID 码（宏导入用）；未知返回 0（与官方 keynameToHid 一致） */
function displayToHid(name) {
  return DISPLAY_TO_HID[name] || 0;
}

/** HID 码 → KeyboardEvent.code（键盘按键导入用）；未知返回 null */
function hidToKeyCode(hidCode) {
  for (const [name, c] of Object.entries(P.HID_KEY_CODES)) {
    if (c === hidCode) return name;
  }
  return null;
}

// ── 颜色：CSS #rrggbb ↔ 官方打包整数 0xBBGGRR ─────────────────
function cssToColorInt(css) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(css).trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (b << 16) | (g << 8) | r;
}

function colorIntToCss(n) {
  const r = n & 255;
  const g = (n >> 8) & 255;
  const b = (n >> 16) & 255;
  const hex = (v) => v.toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

// ── 文本解析（官方 findValForKey 等价）────────────────────────
/** "k1:v1;k2:v2;" → Map（键含 dpi[0] 这类下标原样保留） */
function parseFields(str) {
  const map = new Map();
  for (const part of String(str).split(';')) {
    if (!part) continue;
    const i = part.indexOf(':');
    if (i <= 0) continue;
    map.set(part.slice(0, i), part.slice(i + 1));
  }
  return map;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

// ── 按键：App 表示 ↔ 官方 KeyInfo 五元组 ──────────────────────
/** .ict key[] 是 UI 顺序 [左,右,中,前进,后退,DPI]；App buttons 是矩阵顺序 [左,右,中,后退,前进,DPI] */
const ICT_TO_APP_INDEX = [0, 1, 2, 4, 3, 5];

/** App 按键 {type, value} → 官方五元组 [major, minor, modifer, macro, itemdata] */
function buttonToKeyTuple(btn) {
  switch (btn.type) {
    case 'mouse':
      return [1, MOUSE_MINOR[btn.value] ?? 15, 0, 0, 0];
    case 'keyboard':
      return [2, P.HID_KEY_CODES[btn.value] ?? 0, 0, 0, 0];
    case 'media':
      return [3, MEDIA_MINOR[btn.value] ?? 0, 0, 0, 0];
    case 'macro': {
      const slot = parseInt(btn.value, 10) || 0;
      return [4, 0, 0, 0, slot];
    }
    default:
      return [1, 15, 0, 0, 0]; // 禁用
  }
}

/** 官方五元组 → App 按键 {type, value}（无法识别时禁用） */
function keyTupleToButton(major, minor, modifer, _macro, itemdata) {
  if (major === 1) {
    return { type: 'mouse', value: MINOR_TO_MOUSE[minor] || 'DISABLED' };
  }
  if (major === 2) {
    const code = hidToKeyCode(minor);
    return code ? { type: 'keyboard', value: code } : { type: 'mouse', value: 'DISABLED' };
  }
  if (major === 3) {
    const name = MINOR_TO_MEDIA[minor];
    return name ? { type: 'media', value: name } : { type: 'mouse', value: 'DISABLED' };
  }
  if (major === 4) {
    // 官方的 itemdata 是宏库 uid；本工具导出时写的是槽位号，<10 按槽位还原
    const slot = itemdata >= 0 && itemdata < 10 ? itemdata : 0;
    return { type: 'macro', value: String(slot) };
  }
  return { type: 'mouse', value: 'DISABLED' };
}

// ── .ict 配置导出 ────────────────────────────────────────────
/**
 * 导出当前配置为 .ict 文本（单配置 StProfile 格式）。
 * @param {object} cfg
 *   { name, sensor, rate, lod, sensorMode, angleSnap, ripple, motionSync,
 *     debounce, sleepTime, receiverLed, currentDpi, dpiLevels: [{x,y,color}], buttons: [6] }
 */
function exportProfile(cfg) {
  const levels = cfg.dpiLevels || [];
  let s = '';
  s += `magic:${MAGIC_PROFILE};`;
  s += `name:${cfg.name || 'Profile'};`;
  s += 'inside:false;';
  s += `uid:${Date.now()};`;
  s += `usbrate:${cfg.rate};`;
  s += `lod:${cfg.lod};`;
  s += `sensormode:${cfg.sensorMode ?? 1};`;
  s += `fixline:${!!cfg.angleSnap};`;
  s += `ripple:${!!cfg.ripple};`;
  s += `motion:${!!cfg.motionSync};`;
  s += `debounce:${cfg.debounce};`;
  s += `sleeptime:${cfg.sleepTime};`;
  s += `receiverLED:${cfg.receiverLed ?? 0};`;
  s += `dpisensor:${cfg.sensor ?? P.SENSOR.PAW3395};`;
  s += `curDpi:${cfg.currentDpi};`;
  s += `dpiuinum:${levels.length};`;
  levels.forEach((lv, i) => {
    s += `dpi[${i}]:${lv.x};`;
  });
  levels.forEach((lv, i) => {
    s += `dpiy[${i}]:${lv.y};`;
  });
  levels.forEach((lv, i) => {
    s += `dpicolor[${i}]:${cssToColorInt(lv.color)};`;
  });
  // .ict 顺序 = UI 顺序，需从 App 矩阵顺序换回（前进/后退互换）
  for (let i = 0; i < 6; i++) {
    const btn = (cfg.buttons || [])[ICT_TO_APP_INDEX[i]] || { type: 'mouse', value: 'DISABLED' };
    s += `key[${i}]:${buttonToKeyTuple(btn).join(',')};`;
  }
  return s;
}

// ── .ict 配置导入 ────────────────────────────────────────────
/**
 * 解析 .ict 文本（多配置取第一个），失败返回 null。
 * 返回与 exportProfile 相同结构的对象，外加 skipped 警告数组。
 */
function importProfile(text) {
  const first = String(text).split('|||')[0];
  const f = parseFields(first);
  if (f.get('magic') !== MAGIC_PROFILE) return null;

  const cfg = { skipped: [] };
  cfg.name = f.get('name') || 'Profile';
  cfg.rate = num(f.get('usbrate')) ?? 1000;
  cfg.lod = num(f.get('lod')) ?? 1;
  cfg.sensorMode = num(f.get('sensormode')) ?? 1;
  cfg.angleSnap = bool(f.get('fixline')) ?? false;
  cfg.ripple = bool(f.get('ripple')) ?? false;
  cfg.motionSync = bool(f.get('motion')) ?? true;
  cfg.debounce = num(f.get('debounce')) ?? 8;
  cfg.sleepTime = num(f.get('sleeptime')) ?? 60;
  cfg.receiverLed = num(f.get('receiverLED')) ?? 0;
  cfg.sensor = num(f.get('dpisensor')) ?? P.SENSOR.PAW3395;
  cfg.currentDpi = num(f.get('curDpi')) ?? 0;

  const n = num(f.get('dpiuinum')) ?? 0;
  cfg.dpiLevels = [];
  for (let i = 0; i < n; i++) {
    const x = num(f.get(`dpi[${i}]`));
    const y = num(f.get(`dpiy[${i}]`));
    const c = num(f.get(`dpicolor[${i}]`));
    cfg.dpiLevels.push({
      x: x ?? 800,
      y: y ?? x ?? 800,
      color: c != null ? colorIntToCss(c) : '#4da3ff',
    });
  }

  cfg.buttons = new Array(6);
  for (let i = 0; i < 6; i++) {
    const raw = f.get(`key[${i}]`);
    let btn = { type: 'mouse', value: 'DISABLED' };
    if (raw != null) {
      const arr = raw.split(',').map((v) => num(v) ?? 0);
      if (arr.length === 5) btn = keyTupleToButton(arr[0], arr[1], arr[2], arr[3], arr[4]);
    }
    cfg.buttons[ICT_TO_APP_INDEX[i]] = btn;
  }
  if (cfg.currentDpi >= cfg.dpiLevels.length) cfg.currentDpi = 0;
  return cfg;
}

// ── .icm 宏导出 ──────────────────────────────────────────────
/** 官方 looptype：1=按住循环, 2=任意键停止, 3=循环N次（硬件 loopType 0/1/2 差 1） */
function hwLoopToOfficial(hwLoop) {
  return (hwLoop ?? 2) + 1;
}
function officialLoopToHw(looptype) {
  return looptype - 1;
}

/**
 * 导出宏库为 .icm 文本（STMacroList 格式，多个以 ||| 连接）。
 * 只导出有动作的宏；uid 写槽位号保证本工具往返稳定。
 */
function exportMacros(macros) {
  const parts = [];
  for (const m of macros || []) {
    if (!m || !Array.isArray(m.items) || m.items.length === 0) continue;
    let s = '';
    s += `magic:${MAGIC_MACRO};`;
    s += `name:${m.name || 'Macro'};`;
    s += `uid:${m.slot ?? 0};`;
    s += `looptype:${hwLoopToOfficial(m.loopType)};`;
    s += `cycle:${m.cycle ?? 1};`;
    m.items.forEach((it, i) => {
      const keyName = hidToDisplay(it.keyCode);
      if (!keyName) return; // 无官方显示名的键码跳过（官方格式不支持）
      s += `item[${i}]:${keyName},${it.delay},${!!it.press};`;
    });
    parts.push(s);
  }
  return parts.join('|||');
}

// ── .icm 宏导入 ──────────────────────────────────────────────
/**
 * 解析 .icm 文本（宏库），返回 [{ name, loopType, cycle, items }]（硬件 loopType）。
 * 完全无效返回空数组。
 */
function importMacros(text) {
  const result = [];
  for (const part of String(text).split('|||')) {
    const f = parseFields(part);
    if (f.get('magic') !== MAGIC_MACRO) continue;
    const looptype = num(f.get('looptype'));
    if (looptype == null || looptype < 1 || looptype > 3) continue;
    const m = {
      name: f.get('name') || 'Macro',
      loopType: officialLoopToHw(looptype),
      cycle: Math.min(num(f.get('cycle')) ?? 1, 65535),
      items: [],
    };
    for (let i = 0; i < 71; i++) {
      const raw = f.get(`item[${i}]`);
      if (raw == null) break;
      const arr = raw.split(',');
      if (arr.length !== 3) continue;
      const hid = displayToHid(arr[0]);
      const delay = num(arr[1]);
      const press = arr[2] === 'true' ? true : arr[2] === 'false' ? false : null;
      if (!hid || delay == null || press == null) continue;
      m.items.push({ press, keyCode: hid, delay });
    }
    result.push(m);
  }
  return result;
}

module.exports = {
  MAGIC_PROFILE,
  MAGIC_MACRO,
  hidToDisplay,
  displayToHid,
  cssToColorInt,
  colorIntToCss,
  ICT_TO_APP_INDEX,
  buttonToKeyTuple,
  keyTupleToButton,
  exportProfile,
  importProfile,
  exportMacros,
  importMacros,
};

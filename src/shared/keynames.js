/**
 * 键位显示名 —— 把协议里的原始枚举名（LEFT / KeyA / DPI_LOOP …）翻译成界面文案。
 *
 * 只负责「显示」，协议值一律不变：保存/写入仍然用原始枚举名，
 * 因此导入导出、板载配置、官方格式互转都不受影响。
 */

'use strict';

const MOUSE_LABELS = {
  zh: {
    LEFT: '左键',
    RIGHT: '右键',
    MIDDLE: '中键',
    BACK: '后退',
    FORWARD: '前进',
    DPI_LOOP: 'DPI 循环',
    DPI_INC: 'DPI 加',
    DPI_DEC: 'DPI 减',
    PROFILE: '切换配置',
    FIRE: '火力键',
    DISABLED: '禁用',
  },
  en: {
    LEFT: 'Left click',
    RIGHT: 'Right click',
    MIDDLE: 'Middle click',
    BACK: 'Back',
    FORWARD: 'Forward',
    DPI_LOOP: 'DPI cycle',
    DPI_INC: 'DPI +',
    DPI_DEC: 'DPI −',
    PROFILE: 'Switch profile',
    FIRE: 'Fire',
    DISABLED: 'Disabled',
  },
};

const MEDIA_LABELS = {
  zh: {
    PLAYER: '媒体播放器',
    PLAY_PAUSE: '播放/暂停',
    STOP: '停止',
    PREVIOUS: '上一首',
    NEXT: '下一首',
    VOL_INC: '音量加',
    VOL_DEC: '音量减',
    MUTE: '静音',
    EMAIL: '邮件',
    CALCULATOR: '计算器',
    EXPLORER: '资源管理器',
    HOME: '主页',
    REFRESH: '刷新',
    FORWARD: '浏览器前进',
    BACK: '浏览器后退',
    SEARCH: '搜索',
  },
  en: {
    PLAYER: 'Media player',
    PLAY_PAUSE: 'Play / pause',
    STOP: 'Stop',
    PREVIOUS: 'Previous track',
    NEXT: 'Next track',
    VOL_INC: 'Volume up',
    VOL_DEC: 'Volume down',
    MUTE: 'Mute',
    EMAIL: 'Mail',
    CALCULATOR: 'Calculator',
    EXPLORER: 'File explorer',
    HOME: 'Home',
    REFRESH: 'Refresh',
    FORWARD: 'Browser forward',
    BACK: 'Browser back',
    SEARCH: 'Search',
  },
};

// 特殊键：代码里是 HID 枚举名，界面给中文/英文
const KEY_LABELS = {
  zh: {
    Enter: '回车',
    Escape: 'Esc',
    Backspace: '退格',
    Tab: 'Tab',
    Space: '空格',
    CapsLock: '大写锁定',
    Minus: '−',
    Equal: '＝',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: '；',
    Quote: "'",
    Backquote: '`',
    Comma: '，',
    Period: '。',
    Slash: '/',
    PrintScreen: '截屏',
    ScrollLock: '滚动锁定',
    Pause: '暂停',
    Insert: '插入',
    Home: 'Home',
    PageUp: 'Page Up',
    Delete: 'Delete',
    End: 'End',
    PageDown: 'Page Down',
    NumLock: 'Num Lock',
    IntlBackslash: '\\ (国际)',
    ContextMenu: '菜单键',
    ControlLeft: '左 Ctrl',
    ControlRight: '右 Ctrl',
    ShiftLeft: '左 Shift',
    ShiftRight: '右 Shift',
    AltLeft: '左 Alt',
    AltRight: '右 Alt',
    MetaLeft: '左 Win',
    MetaRight: '右 Win',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  },
  en: {
    Enter: 'Enter',
    Escape: 'Esc',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Space: 'Space',
    CapsLock: 'Caps Lock',
    Minus: '−',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Comma: ',',
    Period: '.',
    Slash: '/',
    PrintScreen: 'Print Screen',
    ScrollLock: 'Scroll Lock',
    Pause: 'Pause',
    Insert: 'Insert',
    Home: 'Home',
    PageUp: 'Page Up',
    Delete: 'Delete',
    End: 'End',
    PageDown: 'Page Down',
    NumLock: 'Num Lock',
    IntlBackslash: '\\ (intl)',
    ContextMenu: 'Menu',
    ControlLeft: 'Left Ctrl',
    ControlRight: 'Right Ctrl',
    ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift',
    AltLeft: 'Left Alt',
    AltRight: 'Right Alt',
    MetaLeft: 'Left Win',
    MetaRight: 'Right Win',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  },
};

const NUMPAD_LABELS = {
  zh: {
    NumpadDivide: '小键盘 /',
    NumpadMultiply: '小键盘 *',
    NumpadSubtract: '小键盘 −',
    NumpadAdd: '小键盘 ＋',
    NumpadEnter: '小键盘回车',
    NumpadDecimal: '小键盘 .',
  },
  en: {
    NumpadDivide: 'Num /',
    NumpadMultiply: 'Num *',
    NumpadSubtract: 'Num −',
    NumpadAdd: 'Num +',
    NumpadEnter: 'Num Enter',
    NumpadDecimal: 'Num .',
  },
};

function normalizeLang(lang) {
  return lang === 'en' ? 'en' : 'zh';
}

/** 键盘键（HID 枚举名）→ 显示名 */
function keyboardLabel(name, lang) {
  const l = normalizeLang(lang);
  if (!name) return '';

  let m = /^Key([A-Z])$/.exec(name);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(name);
  if (m) return m[1];
  m = /^F(\d{1,2})$/.exec(name);
  if (m) return 'F' + m[1];
  m = /^Numpad(\d)$/.exec(name);
  if (m) return (l === 'zh' ? '小键盘 ' : 'Num ') + m[1];

  return KEY_LABELS[l][name] || NUMPAD_LABELS[l][name] || name;
}

/**
 * 统一入口：按类型取显示名。
 * @param {'mouse'|'keyboard'|'media'|'macro'} kind
 * @param {string} value 原始枚举名 / 键码名
 * @param {string} lang 'zh' | 'en'
 */
function keyLabel(kind, value, lang) {
  const l = normalizeLang(lang);
  if (value == null) return '';
  const v = String(value);
  if (kind === 'mouse') return MOUSE_LABELS[l][v] || v;
  if (kind === 'media') return MEDIA_LABELS[l][v] || v;
  if (kind === 'keyboard') return keyboardLabel(v, l);
  return v;
}

module.exports = { keyLabel, keyboardLabel, MOUSE_LABELS, MEDIA_LABELS, KEY_LABELS, NUMPAD_LABELS };

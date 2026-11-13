/**
 * 键位显示名映射测试。
 * 重点：显示名变化不能影响协议值（value 始终是原始枚举名）。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { keyLabel, keyboardLabel } = require('../src/shared/keynames');

test('键名：鼠标键中英文', () => {
  assert.strictEqual(keyLabel('mouse', 'LEFT', 'zh'), '左键');
  assert.strictEqual(keyLabel('mouse', 'LEFT', 'en'), 'Left click');
  assert.strictEqual(keyLabel('mouse', 'DPI_LOOP', 'zh'), 'DPI 循环');
  assert.strictEqual(keyLabel('mouse', 'FIRE', 'en'), 'Fire');
  assert.strictEqual(keyLabel('mouse', 'DISABLED', 'zh'), '禁用');
});

test('键名：未知鼠标键回退原始值', () => {
  assert.strictEqual(keyLabel('mouse', 'SOMETHING_NEW', 'zh'), 'SOMETHING_NEW');
});

test('键名：字母与数字键简写', () => {
  assert.strictEqual(keyboardLabel('KeyA', 'zh'), 'A');
  assert.strictEqual(keyboardLabel('KeyZ', 'en'), 'Z');
  assert.strictEqual(keyboardLabel('Digit1', 'zh'), '1');
  assert.strictEqual(keyboardLabel('Digit0', 'zh'), '0');
});

test('键名：功能键与小键盘', () => {
  assert.strictEqual(keyboardLabel('F1', 'zh'), 'F1');
  assert.strictEqual(keyboardLabel('F13', 'en'), 'F13');
  assert.strictEqual(keyboardLabel('Numpad1', 'zh'), '小键盘 1');
  assert.strictEqual(keyboardLabel('Numpad1', 'en'), 'Num 1');
  assert.strictEqual(keyboardLabel('NumpadEnter', 'zh'), '小键盘回车');
});

test('键名：修饰键与方向键', () => {
  assert.strictEqual(keyboardLabel('ControlLeft', 'zh'), '左 Ctrl');
  assert.strictEqual(keyboardLabel('ShiftRight', 'en'), 'Right Shift');
  assert.strictEqual(keyboardLabel('MetaLeft', 'zh'), '左 Win');
  assert.strictEqual(keyboardLabel('ArrowUp', 'zh'), '↑');
  assert.strictEqual(keyboardLabel('ArrowRight', 'en'), '→');
});

test('键名：多媒体键', () => {
  assert.strictEqual(keyLabel('media', 'VOL_INC', 'zh'), '音量加');
  assert.strictEqual(keyLabel('media', 'PLAY_PAUSE', 'en'), 'Play / pause');
  assert.strictEqual(keyLabel('media', 'MUTE', 'zh'), '静音');
});

test('键名：空值与未知类型不抛错', () => {
  assert.strictEqual(keyLabel('keyboard', null, 'zh'), '');
  assert.strictEqual(keyLabel('keyboard', 30, 'zh'), '30');
  assert.strictEqual(keyLabel('macro', '3', 'zh'), '3');
});

test('键名：语言参数非法时回退中文', () => {
  assert.strictEqual(keyboardLabel('KeyA', 'ja'), 'A');
  assert.strictEqual(keyLabel('mouse', 'MIDDLE', undefined), '中键');
});

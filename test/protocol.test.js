'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/shared/protocol');

test('DPI 映射：hw = (dpi-50)/50，往返一致', () => {
  assert.equal(P.dpiToHw(50), 0);
  assert.equal(P.dpiToHw(800), 15);
  assert.equal(P.dpiToHw(32000), 639);
  assert.equal(P.dpiToHw(45000), 899);
  assert.equal(P.dpiToHw(49), -1); // 越界
  assert.equal(P.hwToDpi(15), 800);
  assert.equal(P.hwToDpi(0), 50);
});

test('传感器最大 DPI', () => {
  assert.equal(P.maxDpiForSensor(P.SENSOR.PAW3395), 32000);
  assert.equal(P.maxDpiForSensor(P.SENSOR.PAW3950), 45000);
});

test('轮询率命令：[1, code]', () => {
  assert.deepEqual([...P.buildSetRate(1000)], [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...P.buildSetRate(125)], [1, 3, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...P.buildSetRate(8000)], [1, 4, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => P.buildSetRate(300), RangeError);
});

test('DPI 档位值命令：[2, ix, lo, hi, 0,0,0, flag]', () => {
  // 800 DPI → hw 15 → lo=15, hi=0
  assert.deepEqual([...P.buildSetResolution(2, 15, 0)], [2, 2, 15, 0, 0, 0, 0, 0]);
  // 32000 DPI → hw 639 → lo=127, hi=2
  assert.deepEqual([...P.buildSetResolution(0, 639, 1)], [2, 0, 127, 2, 0, 0, 0, 1]);
});

test('DPI 档位切换：[3, levels, cur]', () => {
  assert.deepEqual([...P.buildSetDpiLevel(6, 2)], [3, 6, 2, 0, 0, 0, 0, 0]);
});

test('传感器高级设置：[4, sub, val]', () => {
  assert.deepEqual([...P.buildSetLod(1)], [4, 1, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual([...P.buildSetRipple(true)], [4, 2, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual([...P.buildSetAngleSnap(false)], [4, 3, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...P.buildSetMotionSync(true)], [4, 4, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual([...P.buildSetSensorMode(1)], [4, 5, 1, 0, 0, 0, 0, 0]);
});

test('去抖/火力键/睡眠：[5, sub, ...]', () => {
  assert.deepEqual([...P.buildSetDebounce(8)], [5, 1, 8, 0, 0, 0, 0, 0]);
  assert.deepEqual([...P.buildSetDebounce(99)], [5, 1, 30, 0, 0, 0, 0, 0]); // 上限 30
  assert.deepEqual([...P.buildSetFireKey(2, 5)], [5, 2, 2, 5, 0, 0, 0, 0]);
  assert.deepEqual([...P.buildSetSleepTime(600)], [5, 3, 88, 2, 0, 0, 0, 0]); // 600 = 0x258
});

test('按键映射：[6, index, k1..k4] 小端', () => {
  // 左键 0x00F00001 → k1=0x01, k2=0x00, k3=0xF0, k4=0x00
  const b = P.buildSetKey(0, 0x00f00001);
  assert.deepEqual([...b], [6, 0, 0x01, 0x00, 0xf0, 0x00, 0, 0]);
});

test('键码编码：鼠标键', () => {
  assert.equal(P.encodeMouseKey('LEFT'), 0x00f00001);
  assert.equal(P.encodeMouseKey('DPI_LOOP'), 0x00030007);
  assert.equal(P.encodeMouseKey('DISABLED'), 0);
});

test('键码编码：键盘键（无修饰）', () => {
  // A = 0x04 → (0x04 << 8) | 0x80 = 0x0480
  assert.equal(P.encodeKeyboardKey(0x04), 0x0480);
});

test('键码编码：键盘键（有修饰）', () => {
  // A + CtrlL → (0x04 << 16) | (1 << 8) = 0x040100
  assert.equal(P.encodeKeyboardKey(0x04, P.MODIFIERS.CTRL_L), 0x040100);
});

test('键码编码：多媒体键', () => {
  assert.equal(P.encodeMediaKey('VOL_INC'), 0x00e90003);
});

test('键码编码：宏键', () => {
  assert.equal(P.encodeMacroKey(3), (3 << 16) | 9);
});

test('宏编码：320 字节结构', () => {
  const macro = {
    slot: 2,
    loopType: 2, // 循环 N 次
    cycle: 5,
    uid: 0x12345678,
    items: [
      { press: true, keyCode: 0x04, delay: 100 }, // A 按下，延迟 100ms
      { press: false, keyCode: 0x04, delay: 50 }, // A 释放，延迟 50ms
    ],
  };
  const b = P.encodeMacro(macro);
  assert.equal(b.length, 320);
  assert.equal(b[0], 2); // slot
  assert.equal(b[1], 2); // loopType
  assert.equal(b[2], 5); // cycle 低字节
  assert.equal(b[3], 0); // cycle 高字节
  // 第一项
  assert.equal(b[4], (0 | 1)); // press → 1
  assert.equal(b[5], 0x04); // 键码
  assert.equal(b[6], 100); // delay 低
  assert.equal(b[7], 0); // delay 高
  // 第二项
  assert.equal(b[8], (128 | 1)); // release → 129
  assert.equal(b[9], 0x04);
  assert.equal(b[10], 50);
  // 宏名标记 "Macro3"
  assert.equal(String.fromCharCode(b[288], b[289], b[290], b[291], b[292], b[293]), 'Macro3');
  // uid
  assert.equal(b[312] | (b[313] << 8) | (b[314] << 16) | (b[315] << 24), 0x12345678);
});

test('读取命令构造', () => {
  assert.deepEqual([...P.buildReadDpiLevel()], [131, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...P.buildReadBattery()], [137, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...P.buildReadKey(5)], [134, 5, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...P.buildReadMatchInfo()], [142, 1, 0, 0, 0, 0, 0, 0]);
});

test('宏分块命令：[7, totalBlocks, blockIndex, 32, slotId]', () => {
  assert.deepEqual([...P.buildMacroBlock(10, 0, 3)], [7, 10, 0, 32, 3, 0, 0, 0]);
  assert.deepEqual([...P.buildMacroBlock(10, 9, 0)], [7, 10, 9, 32, 0, 0, 0, 0]);
});

test('宏编码可分块：320 字节 = 10 块 × 32 字节', () => {
  const macro = {
    slot: 0,
    loopType: 2,
    cycle: 1,
    uid: 1,
    items: Array.from({ length: 5 }, (_, i) => ({
      press: i % 2 === 0,
      keyCode: 0x04,
      delay: 100,
    })),
  };
  const b = P.encodeMacro(macro);
  assert.equal(b.length, 320);
  // 分块完整性：每块 32 字节，共 10 块，拼回等于原数据
  const blocks = [];
  for (let i = 0; i < 10; i++) blocks.push(b.slice(i * 32, i * 32 + 32));
  assert.equal(blocks.length, 10);
  assert.ok(blocks.every((blk) => blk.length === 32));
  assert.deepEqual(Buffer.concat(blocks), b);
});

test('所有命令输出均为 8 字节', () => {
  const builders = [
    P.buildSetRate(1000),
    P.buildSetResolution(0, 15),
    P.buildSetDpiLevel(6, 2),
    P.buildSetLod(1),
    P.buildSetKey(0, 0x00f00001),
    P.buildSetProfile(2),
    P.buildSetReceiverLed(1),
    P.buildReadDpiLevel(),
  ];
  for (const b of builders) {
    assert.equal(b.length, 8);
  }
});

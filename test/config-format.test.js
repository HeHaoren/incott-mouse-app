'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fmt = require('../src/shared/config-format');
const P = require('../src/shared/protocol');

test('颜色：CSS ↔ 官方 0xBBGGRR 整数', () => {
  assert.equal(fmt.cssToColorInt('#ff0000'), 255); // rgb(255,0,0) → 0x0000FF
  assert.equal(fmt.cssToColorInt('#4da3ff'), 0xffa34d);
  assert.equal(fmt.colorIntToCss(255), '#ff0000');
  assert.equal(fmt.colorIntToCss(fmt.cssToColorInt('#22d3ee')), '#22d3ee');
  assert.equal(fmt.cssToColorInt('垃圾'), 0);
});

test('官方键名表：显示名 ↔ HID 码', () => {
  assert.equal(fmt.displayToHid('A'), 0x04);
  assert.equal(fmt.displayToHid('Enter'), 0x28);
  assert.equal(fmt.displayToHid('Num+'), 0x57);
  assert.equal(fmt.displayToHid('不存在的键'), 0); // 与官方 keynameToHid 一致
  assert.equal(fmt.hidToDisplay(0x04), 'A');
  assert.equal(fmt.hidToDisplay(0x46), null); // PrintScreen 不在官方键表，不导出
});

test('按键五元组：四类互转', () => {
  assert.deepEqual(fmt.buttonToKeyTuple({ type: 'mouse', value: 'FORWARD' }), [1, 4, 0, 0, 0]);
  assert.deepEqual(fmt.buttonToKeyTuple({ type: 'keyboard', value: 'KeyA' }), [2, 0x04, 0, 0, 0]);
  assert.deepEqual(fmt.buttonToKeyTuple({ type: 'media', value: 'PLAY_PAUSE' }), [3, 2, 0, 0, 0]);
  assert.deepEqual(fmt.buttonToKeyTuple({ type: 'macro', value: '3' }), [4, 0, 0, 0, 3]);
  assert.deepEqual(fmt.keyTupleToButton(1, 5, 0, 0, 0), { type: 'mouse', value: 'BACK' });
  assert.deepEqual(fmt.keyTupleToButton(2, 0x04, 0, 0, 0), { type: 'keyboard', value: 'KeyA' });
  assert.deepEqual(fmt.keyTupleToButton(3, 8, 0, 0, 0), { type: 'media', value: 'MUTE' });
  assert.deepEqual(fmt.keyTupleToButton(4, 0, 0, 0, 2), { type: 'macro', value: '2' });
  // 未知值 → 禁用
  assert.deepEqual(fmt.keyTupleToButton(1, 99, 0, 0, 0), { type: 'mouse', value: 'DISABLED' });
});

function sampleProfile() {
  return {
    name: 'Profile 1',
    sensor: P.SENSOR.PAW3950,
    rate: 1000,
    lod: 1,
    sensorMode: 1,
    angleSnap: false,
    ripple: true,
    motionSync: true,
    debounce: 8,
    sleepTime: 600,
    receiverLed: 0,
    currentDpi: 2,
    dpiLevels: [
      { x: 400, y: 400, color: '#ff4d4d' },
      { x: 800, y: 1600, color: '#4da3ff' }, // XY 不一致
      { x: 3200, y: 3200, color: '#3fb950' },
    ],
    // App 矩阵顺序：[左,右,中,后退,前进,DPI]
    buttons: [
      { type: 'mouse', value: 'LEFT' },
      { type: 'mouse', value: 'RIGHT' },
      { type: 'mouse', value: 'MIDDLE' },
      { type: 'mouse', value: 'BACK' },
      { type: 'mouse', value: 'FORWARD' },
      { type: 'macro', value: '1' },
    ],
  };
}

test('.ict 导出：字段与按键顺序（前进/后退换回 UI 顺序）', () => {
  const text = fmt.exportProfile(sampleProfile());
  assert.ok(text.startsWith('magic:incott_magic102;'));
  assert.ok(text.includes('usbrate:1000;'));
  assert.ok(text.includes('dpiuinum:3;'));
  assert.ok(text.includes('dpi[1]:800;'));
  assert.ok(text.includes('dpiy[1]:1600;'));
  assert.ok(text.includes('dpisensor:14672;')); // 0x3950
  // .ict key[3]=前进(fmsFORWARD=4)，key[4]=后退(fmsBACK=5)，key[5]=宏槽1
  assert.ok(text.includes('key[3]:1,4,0,0,0;'));
  assert.ok(text.includes('key[4]:1,5,0,0,0;'));
  assert.ok(text.includes('key[5]:4,0,0,0,1;'));
});

test('.ict 往返：导出→导入 保持一致（含前进/后退顺序）', () => {
  const src = sampleProfile();
  const back = fmt.importProfile(fmt.exportProfile(src));
  assert.equal(back.rate, src.rate);
  assert.equal(back.lod, src.lod);
  assert.equal(back.ripple, true);
  assert.equal(back.angleSnap, false);
  assert.equal(back.motionSync, true);
  assert.equal(back.debounce, 8);
  assert.equal(back.sleepTime, 600);
  assert.equal(back.sensor, P.SENSOR.PAW3950);
  assert.equal(back.currentDpi, 2);
  assert.deepEqual(back.dpiLevels, src.dpiLevels);
  assert.deepEqual(back.buttons, src.buttons);
});

test('.ict 导入：magic 错误返回 null；多配置取第一个', () => {
  assert.equal(fmt.importProfile('magic:wrong;name:x;'), null);
  const two = fmt.exportProfile(sampleProfile()) + '|||' + fmt.exportProfile({ ...sampleProfile(), rate: 500 });
  const back = fmt.importProfile(two);
  assert.equal(back.rate, 1000); // 第一个配置
});

test('.icm 往返：循环类型换算与键名转换', () => {
  const macros = [
    {
      slot: 0,
      name: 'Macro 1',
      loopType: 2, // 硬件：循环 N 次（官方 looptype 3）
      cycle: 5,
      items: [
        { press: true, keyCode: 0x04, delay: 100 }, // A ↓
        { press: false, keyCode: 0x04, delay: 50 }, // A ↑
        { press: true, keyCode: 0x28, delay: 20 }, // Enter ↓
      ],
    },
    { slot: 1, name: 'Macro 2', loopType: 0, cycle: 1, items: [] }, // 空宏不导出
  ];
  const text = fmt.exportMacros(macros);
  assert.ok(text.startsWith('magic:macro100;'));
  assert.ok(text.includes('looptype:3;'));
  assert.ok(text.includes('item[0]:A,100,true;'));
  assert.ok(text.includes('item[1]:A,50,false;'));
  assert.ok(text.includes('item[2]:Enter,20,true;'));
  assert.ok(!text.includes('Macro 2')); // 空宏跳过

  const back = fmt.importMacros(text);
  assert.equal(back.length, 1);
  assert.equal(back[0].loopType, 2); // 官方 3 → 硬件 2
  assert.equal(back[0].cycle, 5);
  assert.deepEqual(back[0].items, macros[0].items);
});

test('.icm 导入：多宏库 ||| 连接、非法项跳过', () => {
  const text =
    'magic:macro100;name:M1;uid:0;looptype:1;cycle:1;item[0]:A,10,true;|||' +
    'magic:macro100;name:M2;uid:1;looptype:2;cycle:1;item[0]:坏键,10,true;item[1]:B,30,false;|||' +
    'magic:wrong;name:Bad;';
  const back = fmt.importMacros(text);
  assert.equal(back.length, 2);
  assert.equal(back[0].loopType, 0); // 按住循环
  assert.equal(back[1].loopType, 1); // 任意键停止
  assert.deepEqual(back[1].items, [{ press: false, keyCode: 0x05, delay: 30 }]); // 坏键跳过
  assert.deepEqual(fmt.importMacros('magic:wrong;'), []); // 全无效 → 空数组
});

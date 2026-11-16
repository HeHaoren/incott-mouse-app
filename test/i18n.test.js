/**
 * i18n 字典完整性测试。
 * 中英文必须同键——少写一边会在切换语言时显示成 key 名（托盘浮层这类新 UI 最容易漏）。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { messages } = require('../src/shared/i18n');

test('i18n：中英文键集合一致', () => {
  const zh = Object.keys(messages.zh).sort();
  const en = Object.keys(messages.en).sort();
  const missingEn = zh.filter((k) => !(k in messages.en));
  const missingZh = en.filter((k) => !(k in messages.zh));
  assert.deepEqual(missingEn, [], `英文缺少: ${missingEn.join(', ')}`);
  assert.deepEqual(missingZh, [], `中文缺少: ${missingZh.join(', ')}`);
  assert.deepEqual(zh, en);
});

test('i18n：文案值非空字符串', () => {
  for (const lang of ['zh', 'en']) {
    for (const [key, value] of Object.entries(messages[lang])) {
      assert.equal(typeof value, 'string', `${lang}.${key} 不是字符串`);
      assert.ok(value.length > 0, `${lang}.${key} 为空`);
    }
  }
});

test('i18n：托盘浮层占位符齐全', () => {
  for (const lang of ['zh', 'en']) {
    const tpl = messages[lang].trayLevelOf;
    assert.ok(tpl.includes('{n}') && tpl.includes('{m}'), `${lang}.trayLevelOf 缺占位符`);
  }
});

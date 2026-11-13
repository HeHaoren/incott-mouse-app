/**
 * 把打好的安装器从 dist/setup-build 收到 dist/ 根下，方便分发。
 * （构建输出必须和应用的 dist/win-unpacked 分开，否则会互相覆盖）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FROM = path.join(ROOT, 'dist', 'setup-build');
const TO = path.join(ROOT, 'dist');

if (!fs.existsSync(FROM)) {
  console.error('[setup] 没找到 dist/setup-build，先跑 electron-builder');
  process.exit(1);
}

const exes = fs
  .readdirSync(FROM)
  .filter((f) => f.toLowerCase().endsWith('.exe') && /Setup/i.test(f));

if (!exes.length) {
  console.error('[setup] dist/setup-build 里没有安装器 exe');
  process.exit(1);
}

for (const f of exes) {
  const src = path.join(FROM, f);
  const dest = path.join(TO, f);
  fs.copyFileSync(src, dest);
  const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
  console.log(`[setup] ${f}  ${mb} MB`);
}

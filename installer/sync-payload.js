/**
 * 把已构建的应用（dist/win-unpacked）同步成安装器的载荷（installer/payload）。
 * 由根目录 `npm run setup` 调用，保证安装器里装的就是刚打出来的那份应用。
 *
 * 采用覆盖式增量同步（不整目录删除）：既快，也避免被环境的批量删除保护拦下。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'dist', 'win-unpacked');
const DEST = path.join(__dirname, 'payload');

function fail(msg) {
  console.error('[setup] ' + msg);
  process.exit(1);
}

if (!fs.existsSync(SRC)) fail('找不到 dist/win-unpacked，请先运行 npm run dist');
if (!fs.existsSync(path.join(SRC, 'Incott Mouse Driver.exe'))) {
  fail('dist/win-unpacked 里没有主程序，先重新打包应用');
}

function walk(dir, base = dir, out = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.set(path.relative(base, full), fs.statSync(full).size);
  }
  return out;
}

// 1) 覆盖复制（新增 + 更新）
fs.mkdirSync(DEST, { recursive: true });
fs.cpSync(SRC, DEST, { recursive: true, force: true });

// 2) 载荷里不需要的文件
const junk = ['resources/app-update.yml'];
for (const rel of junk) {
  const p = path.join(DEST, rel);
  if (fs.existsSync(p)) {
    try {
      fs.rmSync(p, { force: true });
    } catch (_) { /* 忽略 */ }
  }
}

// 3) 清掉源里已经不存在的残留文件（逐个小批量删，通常只有个位数）
const srcFiles = walk(SRC);
const destFiles = walk(DEST);
let pruned = 0;
for (const rel of destFiles.keys()) {
  if (srcFiles.has(rel) || junk.includes(rel)) continue;
  try {
    fs.rmSync(path.join(DEST, rel), { force: true });
    pruned++;
  } catch (_) { /* 忽略 */ }
}

const files = walk(DEST);
const bytes = [...files.values()].reduce((s, n) => s + n, 0);
console.log(
  `[setup] 载荷就绪：${files.size} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB` +
    (pruned ? `（清理 ${pruned} 个残留）` : '')
);

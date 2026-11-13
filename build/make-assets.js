/**
 * 生成安装包品牌资产：应用图标 .ico + 安装器侧图/顶图 .bmp
 *
 * 用 Electron 自己的渲染引擎把 build/assets-src.html 画出来再截图，
 * 不依赖外部图形库（本机没有 ImageMagick / canvas）。
 *
 * 用法：npx electron build/make-assets.js
 */

'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'assets-src.html');
const OUT = path.join(__dirname, 'generated');
const VERSION = require('../package.json').version;

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration(); // 关掉 GPU 抖动，截图颜色更稳

/** BGRA（nativeImage.toBitmap）→ 24 位 BMP */
function bgraToBmp(bitmap, width, height) {
  const rowSize = width * 3;
  const padding = (4 - (rowSize % 4)) % 4;
  const pixelBytes = (rowSize + padding) * height;
  const buf = Buffer.alloc(54 + pixelBytes);

  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + pixelBytes, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // 正数 = 自下而上
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);

  let o = 54;
  for (let y = height - 1; y >= 0; y--) {
    const srcRow = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = srcRow + x * 4;
      buf[o++] = bitmap[i]; // B
      buf[o++] = bitmap[i + 1]; // G
      buf[o++] = bitmap[i + 2]; // R
    }
    o += padding;
  }
  return buf;
}

/** BGRA 位图 → ICO 内嵌的 DIB 条目（含 AND 掩码，兼容所有 Windows shell 路径） */
function bgraToIconDib(bitmap, width, height) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8); // XOR + AND 两段
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB

  const pixels = Buffer.alloc(width * height * 4);
  let o = 0;
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = row + x * 4;
      pixels[o++] = bitmap[i]; // B
      pixels[o++] = bitmap[i + 1]; // G
      pixels[o++] = bitmap[i + 2]; // R
      pixels[o++] = bitmap[i + 3]; // A
    }
  }

  const maskStride = (((width + 31) >> 5) << 2);
  const mask = Buffer.alloc(maskStride * height); // 全 0：靠 alpha 通道做透明

  return Buffer.concat([header, pixels, mask]);
}

/** 多尺寸 → ICO：≤128 用 DIB（兼容性最好），256 用 PNG（体积小） */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;

  entries.forEach((e, i) => {
    const p = i * 16;
    dir[p] = e.size >= 256 ? 0 : e.size;
    dir[p + 1] = e.size >= 256 ? 0 : e.size;
    dir[p + 2] = 0;
    dir[p + 3] = 0;
    dir.writeUInt16LE(1, p + 4);
    dir.writeUInt16LE(32, p + 6);
    dir.writeUInt32LE(e.data.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += e.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

async function capture(win, kind, width, height, extra = {}) {
  win.setContentSize(width, height);
  const qs = new URLSearchParams({ kind, v: VERSION, ...extra }).toString();
  const url = 'file:///' + SRC.replace(/\\/g, '/') + '?' + qs;
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, 420)); // 等字体与渐变稳定
  return win.webContents.capturePage();
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 200,
    height: 200,
    useContentSize: true,
    frame: false,
    show: false,
    resizable: false,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false, zoomFactor: 1 },
  });

  // 安装器侧图 164×314（electron-builder 要求 BMP）
  const side = await capture(win, 'sidebar', 164, 314);
  const sideSize = side.getSize();
  fs.writeFileSync(
    path.join(OUT, 'installerSidebar.bmp'),
    bgraToBmp(side.toBitmap(), sideSize.width, sideSize.height)
  );
  console.log('installerSidebar.bmp', sideSize.width + 'x' + sideSize.height);

  // 安装器顶图 150×57
  const head = await capture(win, 'header', 150, 57);
  const headSize = head.getSize();
  fs.writeFileSync(
    path.join(OUT, 'installerHeader.bmp'),
    bgraToBmp(head.toBitmap(), headSize.width, headSize.height)
  );
  console.log('installerHeader.bmp', headSize.width + 'x' + headSize.height);

  // 应用图标：多尺寸 ICO + 256 PNG
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = [];
  for (const size of sizes) {
    const img = await capture(win, 'icon', size, size, { size: String(size) });
    if (size >= 256) {
      entries.push({ size, data: img.toPNG() });
      fs.writeFileSync(path.join(OUT, 'icon.png'), img.toPNG());
    } else {
      entries.push({ size, data: bgraToIconDib(img.toBitmap(), size, size) });
    }
  }
  fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco(entries));
  console.log('icon.ico', sizes.join('/'));

  win.destroy();
  console.log('done →', OUT);
  app.quit();
}).catch((e) => {
  console.error('资产生成失败:', e);
  app.exit(1);
});

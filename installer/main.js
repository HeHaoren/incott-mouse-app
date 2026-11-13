/**
 * Incott Mouse Driver —— 自绘安装程序（主进程）
 *
 * 不依赖 NSIS 的向导外壳：窗口、按钮、进度条全部由渲染层画，
 * 安装动作在这里做——复制载荷、建快捷方式、写卸载注册表项。
 */

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
// Electron 的 fs 会把 .asar 当目录拦截，复制载荷里的 app.asar 会报 ENOENT，
// 这里必须用 original-fs（未经 asar 补丁的原始实现）。
const fs = require('original-fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const APP_NAME = 'Incott Mouse Driver';
const APP_EXE = APP_NAME + '.exe';
const APP_ID = 'com.incott.mouseapp';
const MARKER = '.incott-install.json';

// 打包后载荷在 resources/payload；开发时（直接 electron installer）落在 installer/payload
const PAYLOAD = fs.existsSync(path.join(process.resourcesPath, 'payload'))
  ? path.join(process.resourcesPath, 'payload')
  : path.join(__dirname, 'payload');
const VERSION = require('./package.json').version;

let win = null;
let busy = false;
let canceled = false;

// ── 小工具 ──────────────────────────────────────────────

/** execFile 的安全封装：外部程序缺失或被策略拦截时 resolve 成 err，不抛异常 */
function execFileSafe(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true }, (err, stdout) => {
        resolve({ err: err || null, stdout: stdout ? String(stdout) : '' });
      });
    } catch (e) {
      resolve({ err: e, stdout: '' });
    }
  });
}

function defaultDir() {
  // Electron 没有 'localAppData' 这个 path 名，Windows 下取环境变量
  const local = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
  return path.join(local, 'Programs', APP_NAME);
}

function exeIn(dir) {
  return path.join(dir, APP_EXE);
}

/** 读注册表里的安装信息（上一次装在哪） */
async function readInstallRecord() {
  const { err, stdout } = await execFileSafe('reg', [
    'query',
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}`,
  ]);
  if (err || !stdout) return null;
  const get = (key) => {
    const m = new RegExp(`${key}\\s+REG_\\w+\\s+(.+)`).exec(stdout);
    return m ? m[1].trim() : '';
  };
  return { dir: get('InstallLocation') || '', version: get('DisplayVersion') || '' };
}

/** 目标目录里是不是我们的旧版本 */
function isOurInstall(dir) {
  try {
    return fs.existsSync(path.join(dir, MARKER)) || fs.existsSync(exeIn(dir));
  } catch (_) {
    return false;
  }
}

function dirIsEmpty(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch (_) {
    return true;
  }
}

async function killRunningApp() {
  await execFileSafe('taskkill', ['/F', '/IM', APP_EXE]);
}

function sendProgress(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('setup:progress', payload);
}

/** 递归列出文件（含字节数） */
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push({ src: full, rel: path.relative(base, full), size: fs.statSync(full).size });
  }
  return out;
}

async function createShortcut(lnkPath, targetDir) {
  const target = exeIn(targetDir);
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut('${lnkPath.replace(/'/g, "''")}')`,
    `$sc.TargetPath = '${target.replace(/'/g, "''")}'`,
    `$sc.WorkingDirectory = '${targetDir.replace(/'/g, "''")}'`,
    `$sc.IconLocation = '${target.replace(/'/g, "''")},0'`,
    `$sc.Description = '${APP_NAME}'`,
    '$sc.Save()',
  ].join('; ');
  const { err } = await execFileSafe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (err) throw err;
}

async function regAdd(values) {
  const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}`;
  const args = ['add', key, '/f'];
  for (const [name, val] of Object.entries(values)) {
    args.push('/v', name);
    if (typeof val === 'number') args.push('/t', 'REG_DWORD', '/d', String(val));
    else args.push('/t', 'REG_SZ', '/d', String(val));
  }
  const { err } = await execFileSafe('reg', args);
  if (err) throw err;
}

async function regDelete() {
  const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}`;
  await execFileSafe('reg', ['delete', key, '/f']);
}

function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ── 安装主流程 ──────────────────────────────────────────

async function runInstall(opts) {
  const dir = opts.dir;
  canceled = false;
  const warnings = [];

  sendProgress({ phase: 'prepare', percent: 0, detail: '检查安装位置…' });

  fs.mkdirSync(dir, { recursive: true });

  // 旧版本先关掉，否则文件被占用
  await killRunningApp();

  // 清掉旧安装（只清理我们自己的目录）
  if (fs.existsSync(dir) && isOurInstall(dir)) {
    sendProgress({ phase: 'prepare', percent: 1, detail: '清理旧版本文件…' });
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
    }
  } else if (!dirIsEmpty(dir)) {
    throw new Error('所选目录不是空目录，请换一个位置');
  }

  // 复制载荷
  sendProgress({ phase: 'copy', percent: 2, detail: '读取安装包…' });
  const files = walk(PAYLOAD);
  const totalBytes = files.reduce((s, f) => s + f.size, 0) || 1;
  let doneBytes = 0;
  let doneFiles = 0;
  let lastPct = -1;

  for (const f of files) {
    if (canceled) throw new Error('CANCELED');
    const dest = path.join(dir, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.src, dest);
    doneBytes += f.size;
    doneFiles++;
    const pct = 2 + Math.floor((doneBytes / totalBytes) * 78);
    if (pct !== lastPct) {
      lastPct = pct;
      sendProgress({
        phase: 'copy',
        percent: pct,
        detail: `正在写入文件（${doneFiles}/${files.length}）`,
      });
    }
  }

  // 快捷方式
  sendProgress({ phase: 'shortcut', percent: 82, detail: '创建快捷方式…' });
  try {
    if (opts.desktopShortcut) {
      await createShortcut(path.join(app.getPath('desktop'), `${APP_NAME}.lnk`), dir);
    }
    if (opts.startMenuShortcut) {
      const programDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
      fs.mkdirSync(programDir, { recursive: true });
      await createShortcut(path.join(programDir, `${APP_NAME}.lnk`), dir);
    }
  } catch (e) {
    warnings.push('快捷方式创建失败，可在安装目录手动创建');
  }

  // 卸载注册表项（失败不阻断：程序仍然可用，只是「应用和功能」里没有条目）
  sendProgress({ phase: 'registry', percent: 92, detail: '注册卸载信息…' });
  let sizeKB = 0;
  try {
    sizeKB = Math.round(walk(dir).reduce((s, f) => s + f.size, 0) / 1024);
  } catch (_) { /* 忽略 */ }
  try {
    await regAdd({
      DisplayName: APP_NAME,
      DisplayVersion: VERSION,
      Publisher: 'Incott Dev',
      InstallLocation: dir,
      DisplayIcon: exeIn(dir) + ',0',
      UninstallString: `"${exeIn(dir)}" --uninstall`,
      QuietUninstallString: `"${exeIn(dir)}" --uninstall`,
      NoModify: 1,
      NoRepair: 1,
      EstimatedSize: sizeKB,
    });
  } catch (e) {
    warnings.push('卸载信息写入失败，需手动删除安装目录');
  }

  // 安装标记（用于识别旧版本）
  fs.writeFileSync(
    path.join(dir, MARKER),
    JSON.stringify({ appId: APP_ID, version: VERSION, installedAt: new Date().toISOString() }, null, 2)
  );

  sendProgress({ phase: 'done', percent: 100, detail: fmtMB(totalBytes) + ' 已写入' });

  if (opts.launch) {
    try {
      spawn(exeIn(dir), [], { detached: true, stdio: 'ignore', cwd: dir }).unref();
    } catch (_) { /* 忽略 */ }
  }
  return { dir, warnings };
}

// ── 窗口 ────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 660,
    height: 436,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false,
    title: `${APP_NAME} 安装程序`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });
}

ipcMain.handle('setup:info', async () => {
  const record = await readInstallRecord();
  const defaultTarget = defaultDir();
  let existing = null;
  if (record && record.dir && fs.existsSync(record.dir)) {
    existing = { dir: record.dir, version: record.version };
  } else if (isOurInstall(defaultTarget)) {
    existing = { dir: defaultTarget, version: '' };
  }
  return {
    version: VERSION,
    appName: APP_NAME,
    defaultDir: existing ? existing.dir : defaultTarget,
    existing,
    payloadBytes: (() => {
      try {
        return walk(PAYLOAD).reduce((s, f) => s + f.size, 0);
      } catch (_) {
        return 0;
      }
    })(),
    freeBytes: 0,
  };
});

ipcMain.handle('setup:browse', async (_e, current) => {
  const { canceled: c, filePaths } = await dialog.showOpenDialog(win, {
    title: '选择安装位置',
    defaultPath: current || defaultDir(),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '选择此文件夹',
  });
  if (c || !filePaths.length) return { canceled: true };
  return { canceled: false, dir: filePaths[0] };
});

ipcMain.handle('setup:install', async (_e, opts) => {
  if (busy) return { ok: false, error: '正在安装中' };
  busy = true;
  try {
    const res = await runInstall(opts || {});
    return { ok: true, dir: res.dir, warnings: res.warnings || [] };
  } catch (e) {
    if (e && e.message === 'CANCELED') return { ok: false, canceled: true };
    return { ok: false, error: e.message || String(e) };
  } finally {
    busy = false;
  }
});

ipcMain.handle('setup:cancel', () => {
  canceled = true;
  return true;
});

/** 完成页点「完成」时启动已装好的程序 */
ipcMain.handle('setup:launch', (_e, dir) => {
  try {
    spawn(exeIn(dir), [], { detached: true, stdio: 'ignore', cwd: dir }).unref();
    return true;
  } catch (_) {
    return false;
  }
});

ipcMain.handle('setup:minimize', () => {
  if (win) win.minimize();
});

ipcMain.handle('setup:close', () => {
  if (win) win.close();
});

ipcMain.handle('setup:openFolder', (_e, dir) => {
  if (dir) shell.openPath(dir);
});

// 卸载后清理残留（安装器不再负责，交给装好的应用自己处理 --uninstall）

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

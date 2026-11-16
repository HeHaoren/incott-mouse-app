/**
 * 托盘信息弹窗（tray popover）。
 *
 * 单击托盘图标弹出的简易信息面板：电量 / 当前 DPI 档位 / 回报率 / 配置序号。
 * 再单击托盘图标（或点击弹窗外部、按 Esc）收起；双击托盘图标打开主窗口。
 *
 * 本模块只负责窗口生命周期与屏幕定位，数据由调用方通过 getStatus 提供，
 * 避免与主进程的设备状态产生循环依赖。
 */

'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const WIDTH = 268;
const HEIGHT = 180;
const EDGE_GAP = 8; // 与托盘图标/屏幕边缘的间距
// 刚显示时的短暂失焦不算「点击外部」——Windows 上 show() 会先抢焦点再稳定
const BLUR_ARM_DELAY = 180;
// 失焦收起后，紧跟着的这次托盘单击视为「关闭动作」，不再重新弹出
const REOPEN_GUARD = 260;

/**
 * @param {object} opts
 * @param {function(): object} opts.getStatus 返回面板要显示的当前状态
 */
function createTrayPopover({ getStatus }) {
  let win = null;
  let blurArmed = false;
  let hiddenAt = 0;

  function ensure() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false, // 阴影与描边都由 CSS 画（透明窗口下 DWM 不画阴影）
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      roundedCorners: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'pop-up-menu'); // 高于普通窗口，低于系统菜单
    win.loadFile(path.join(__dirname, '../renderer/popover.html'));
    // 点击弹窗外部（窗口失焦）即收起，符合托盘浮层的系统习惯
    win.on('blur', () => {
      if (blurArmed) hide();
    });
    win.on('closed', () => {
      win = null;
    });
    return win;
  }

  /** 贴着托盘图标定位：任务栏在屏幕下半部时显示在图标上方，否则显示在下方 */
  function position(tray) {
    const w = ensure();
    let bounds = null;
    try {
      const b = tray && tray.getBounds ? tray.getBounds() : null;
      if (b && b.width > 0 && b.height > 0) bounds = b;
    } catch (_) {
      /* 托盘图标不可见（被折叠进溢出区）时拿不到位置 */
    }
    const cursor = screen.getCursorScreenPoint();
    const anchor = bounds
      ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      : cursor;
    const wa = screen.getDisplayNearestPoint(anchor).workArea;
    const [ww, wh] = w.getSize();

    let x = Math.round(anchor.x - ww / 2);
    x = Math.min(Math.max(x, wa.x + 4), wa.x + wa.width - ww - 4);

    const below = anchor.y < wa.y + wa.height / 2;
    let y = bounds
      ? (below ? bounds.y + bounds.height + EDGE_GAP : bounds.y - wh - EDGE_GAP)
      : (below ? cursor.y + EDGE_GAP : cursor.y - wh - EDGE_GAP);
    y = Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - wh - 4);

    w.setPosition(x, y, false);
  }

  function sendStatus() {
    if (!win || win.isDestroyed()) return;
    const status = getStatus();
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        if (win && !win.isDestroyed()) win.webContents.send('tray:status', status);
      });
    } else {
      win.webContents.send('tray:status', status);
    }
  }

  /** 转发主进程广播（如语言切换）给浮层；窗口未创建时无需处理（下次打开会重新拉状态） */
  function broadcast(channel, payload) {
    if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
      win.webContents.send(channel, payload);
    }
  }

  function show(tray) {
    const w = ensure();
    position(tray);
    w.show();
    w.focus();
    blurArmed = false;
    setTimeout(() => {
      blurArmed = true;
    }, BLUR_ARM_DELAY);
    sendStatus();
    if (!w.webContents.isLoading()) w.webContents.send('popover:shown'); // 触发淡入动画
  }

  function hide() {
    if (!win || win.isDestroyed()) return;
    if (win.isVisible()) {
      win.hide();
      hiddenAt = Date.now();
    }
  }

  function isVisible() {
    return !!(win && !win.isDestroyed() && win.isVisible());
  }

  /** 预先建好窗口并加载页面（不显示），让首次单击没有 200~300ms 的白屏延迟 */
  function warmup() {
    ensure();
  }

  /** 单击托盘：显示 / 收起。刚因失焦收起时不再重开（那一下点击就是关闭动作） */
  function toggle(tray) {
    if (isVisible()) {
      hide();
      return;
    }
    if (Date.now() - hiddenAt < REOPEN_GUARD) return;
    show(tray);
  }

  function destroy() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  return { show, hide, toggle, isVisible, sendStatus, broadcast, warmup, destroy };
}

module.exports = { createTrayPopover };

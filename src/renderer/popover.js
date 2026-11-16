/**
 * 托盘信息弹窗的渲染逻辑。
 *
 * 只做三件事：把主进程推来的状态画到界面上、按 i18n 切换文案、把点击转成主进程动作。
 * 状态结构见主进程 trayStatus()：
 *   { connected, name, wireless, battery, charging, dpi, dpiIndex, levels, rate, profile, profileCount }
 */

'use strict';

// 注意：不能写成 `const api = window.api`——contextBridge 会在全局定义不可配置的 `api`，
// 顶层 const 同名会直接 SyntaxError（Identifier 'api' has already been declared）。
const bridge = window.api;
const t = (key) => window.i18n.t(key);

const el = {
  dot: document.getElementById('pvDot'),
  name: document.getElementById('pvName'),
  state: document.getElementById('pvState'),
  battery: document.getElementById('pvBattery'),
  charging: document.getElementById('pvCharging'),
  fill: document.getElementById('pvFill'),
  dpi: document.getElementById('pvDpi'),
  rate: document.getElementById('pvRate'),
  profile: document.getElementById('pvProfile'),
  foot: document.getElementById('pvFoot'),
};

let lastStatus = null;
let renderedLang = null;

/** 静态文案走 data-i18n（与主界面同一套约定） */
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  renderedLang = window.i18n.getLang();
}

function setValue(node, text) {
  node.textContent = text;
  node.classList.toggle('dim', text === '--');
}

function render(status) {
  if (!status) return;
  lastStatus = status;
  // 主进程可能在面板隐藏期间切了语言，重绘前先对齐文案
  if (renderedLang !== window.i18n.getLang()) applyI18n();

  el.dot.classList.toggle('on', !!status.connected);
  el.name.textContent = status.connected ? (status.name || 'Incott') : 'Incott';

  if (!status.connected) {
    el.state.textContent = t('notConnected');
  } else if (status.levels && status.dpiIndex != null) {
    el.state.textContent = t('trayLevelOf')
      .replace('{n}', status.dpiIndex + 1)
      .replace('{m}', status.levels);
  } else {
    el.state.textContent = '';
  }

  // 电量：null 表示未连接/未读到（设备休眠时读到 0 也算无效，主进程已过滤）
  const level = status.battery;
  el.battery.textContent = level == null ? '--' : String(level);
  el.charging.classList.toggle('hidden', !(status.charging && level != null));
  const pct = level == null ? 0 : Math.min(Math.max(level, 0), 100);
  el.fill.style.width = `${pct}%`;
  el.fill.className = 'pv-fill';
  if (level == null) el.fill.classList.add('off');
  else if (level <= 25) el.fill.classList.add('low');
  else if (level <= 60) el.fill.classList.add('mid');

  setValue(el.dpi, status.dpi == null ? '--' : String(status.dpi));

  if (status.rate == null) {
    setValue(el.rate, '--');
  } else {
    el.rate.textContent = '';
    el.rate.append(String(status.rate));
    const unit = document.createElement('small');
    unit.textContent = 'Hz';
    el.rate.append(unit);
    el.rate.classList.remove('dim');
  }

  const total = status.profileCount || 5;
  setValue(el.profile, status.profile == null ? '--' : `${status.profile + 1} / ${total}`);
}

function openMain() {
  bridge.openMainFromTray();
}

el.foot.addEventListener('click', openMain);
el.foot.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openMain();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') bridge.hideTrayPopover();
});

async function boot() {
  applyI18n();
  try {
    render(await bridge.getTrayStatus());
  } catch (_) {
    /* 主进程尚未就绪时留空面板，稍后推送会补上 */
  }
  bridge.onTrayStatus(render);
  // 每次弹出播放一次淡入（窗口常驻，隐藏再从左上角"跳"出来会显得生硬）
  bridge.onPopoverShown(() => {
    document.body.classList.remove('pv-in');
    void document.body.offsetWidth; // 强制重排，让动画能重复触发
    document.body.classList.add('pv-in');
  });
  // 打开面板时补一次实时读取（缓存值先显示，读到再刷新），失败沿用缓存
  bridge.refreshTrayStatus().then(render).catch(() => {});
  window.i18n.onLangChanged(() => {
    applyI18n();
    if (lastStatus) render(lastStatus);
  });
}

boot();

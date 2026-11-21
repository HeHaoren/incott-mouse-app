/**
 * 渲染进程逻辑。
 *
 * 通过 window.api（preload 暴露）与主进程通信。
 * 核心：DPI 档位管理（滑块 + 精确输入 + XY 分离 + 档位切换）、性能设置、应用流程。
 */

'use strict';

// ── 全局状态 ──────────────────────────────────────────────
const state = {
  connected: false,
  isWireless: false,
  modelInfo: null, // 0x8F 型号信息 { model, modelCode, is8KReceiver, sensor }
  battery: null,
  batteryCharging: false,
  constants: null,
  maxDpi: 32000,
  dpiLevels: [], // [{ x, y, color }]
  currentDpi: 0,
  xySplit: false,
  rate: 1000,
  lod: 0,
  ripple: false,
  angleSnap: false,
  motionSync: false,
  debounce: 8,
  sensorMode: 2, // 性能模式：3=电竞 2=标准 1=节能（0x84 sub5 回读，G24 实测 2）
  sleepTime: 60, // 节能调节（秒），官方档位 10~900
  receiverLed: 0, // 接收器指示灯模式 0=回报率 1=电量 2=仅低电量
  profile: 0, // 当前配置序号 0..4
  profiles: [], // 5 份配置预设（硬件只有 1 份，见 protocol.js PROFILE_COUNT）
  switching: false, // 正在切换配置（写入整套配置，避免并发）
  buttons: [], // [{ type: 'mouse'|'keyboard'|'media'|'macro', value }]
  macros: [], // [{ slot, name, loopType, cycle, items: [{press, keyCode, delay}] }]
  currentMacro: 0,
};

const $ = (sel) => document.querySelector(sel);
const t = (key) => window.i18n.t(key);

/**
 * 档位颜色：固定为官方默认六色（红/蓝/绿/黄/青/品红），界面与 .ict 存档都用这套，
 * 不给用户改的入口。鼠标指示灯的颜色由固件按「回报率 / 电量」决定（官方手册 §5.4），
 * 命令 2 的 buf[4..6] 虽然能写能回读，但固件只存不用 —— 开放改色只会误导。
 */
const DPI_LEVEL_COLORS = ['#ff0000', '#0000ff', '#00ff00', '#ffff00', '#00ffff', '#ff00ff'];
const dpiColorAt = (i) => DPI_LEVEL_COLORS[i % DPI_LEVEL_COLORS.length];


/** 应用 i18n：替换所有带 data-i18n 属性的静态文案 */
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  // 语言菜单高亮当前语言
  const lang = window.i18n.getLang();
  document.querySelectorAll('.lang-option').forEach((opt) => {
    opt.classList.toggle('active', opt.dataset.lang === lang);
  });
}

/** 展开/收起语言菜单 */
function toggleLangMenu() {
  const menu = $('#langMenu');
  const opening = menu.classList.contains('hidden');
  if (opening) $('#settingsMenu').classList.add('hidden');
  menu.classList.toggle('hidden');
  if (opening) {
    const first = menu.querySelector('.lang-option');
    if (first) first.focus();
  }
}

/** 展开/收起设置面板 */
function toggleSettingsMenu() {
  const menu = $('#settingsMenu');
  const opening = menu.classList.contains('hidden');
  if (opening) $('#langMenu').classList.add('hidden');
  menu.classList.toggle('hidden');
  if (opening) {
    const first = menu.querySelector('input');
    if (first) first.focus();
  }
}

/** 顶栏更新按钮：展开设置面板并立即检查（让用户看到状态行） */
function openUpdatePanel() {
  const menu = $('#settingsMenu');
  if (menu.classList.contains('hidden')) {
    $('#langMenu').classList.add('hidden');
    menu.classList.remove('hidden');
  }
  checkForUpdates(true);
}

/** 更新设置项（开机自启 / 静默启动），成功/失败都弹提示 */
async function onSettingChange(patch, labelKey, enabled) {
  try {
    await window.api.setSettings(patch);
    if (labelKey) {
      const tpl = enabled ? t('settingEnabled') : t('settingDisabled');
      showToast(tpl.replace('{n}', t(labelKey)));
    }
  } catch (_) {
    showToast(t('settingSaveFailed'));
  }
  syncSilentAvailability();
}

/** 静默启动只在开机自启开启时才有意义，未开自启时置灰 */
function syncSilentAvailability() {
  const auto = $('#setAutoLaunch').checked;
  const silent = $('#setSilentStart');
  silent.disabled = !auto;
  silent.closest('.settings-item').style.opacity = auto ? '' : '0.45';
}

/** 界面缩放：'auto' 按屏幕可用尺寸推算，否则用固定倍率 */
function resolveUiScale(pref) {
  if (pref && pref !== 'auto') {
    const n = parseFloat(pref);
    if (isFinite(n) && n >= 0.85 && n <= 2) return n;
  }
  const w = window.screen.availWidth || 1920;
  const h = window.screen.availHeight || 1080;
  const raw = Math.max(w / 1920, h / 1080);
  // 1.00–1.30，按 0.05 台阶取整
  return Math.min(1.3, Math.max(1, Math.round(raw * 20) / 20));
}

/** 只缩放字号与图标（--ui-scale），布局尺寸不动 */
function applyUiScale(pref) {
  const scale = resolveUiScale(pref);
  document.documentElement.style.setProperty('--ui-scale', String(scale));
  return scale;
}

/** 读取设置并回填开关 */
async function loadSettings() {
  try {
    const s = await window.api.getSettings();
    $('#setAutoLaunch').checked = !!s.autoLaunch;
    $('#setSilentStart').checked = !!s.silentStart;
    const sel = $('#setUiScale');
    const allowed = ['auto', '1', '1.1', '1.25', '1.5'];
    sel.value = allowed.includes(s.uiScale) ? s.uiScale : 'auto';
    applyUiScale(sel.value);
    syncSilentAvailability();
  } catch (_) {
    /* 读设置失败静默 */
  }
}

// ── 软件更新（GitHub Releases）──────────────────────────────
let updateInfo = null; // 最近一次检查结果
let updateBusy = false; // 检查/下载进行中

function setUpdateStatus(text) {
  const el = $('#updateStatus');
  if (el) el.textContent = text;
}

/** 按当前状态重绘更新行（语言切换、renderAll 后调用） */
function renderUpdateRow() {
  if (updateBusy) return; // 进行中不覆盖进度/状态
  const btn = $('#updateBtn');
  if (!btn) return;
  // 顶栏按钮上的小红点：有新版本时提示
  const topBtn = $('#updateTopBtn');
  if (topBtn) topBtn.classList.toggle('has-update', !!(updateInfo && updateInfo.hasUpdate));
  btn.classList.remove('accent');
  if (updateInfo && updateInfo.hasUpdate) {
    setUpdateStatus(t('updateAvailable').replace('{latest}', updateInfo.latest).replace('{current}', updateInfo.current));
    btn.textContent = t('updateDownload');
    btn.classList.add('accent');
  } else if (updateInfo) {
    setUpdateStatus(t('updateLatest').replace('{current}', updateInfo.current));
    btn.textContent = t('updateCheck');
  } else {
    setUpdateStatus(t('settingsUpdateIdle'));
    btn.textContent = t('updateCheck');
  }
}

/** manual=false 时用于启动后的静默检查：失败不打扰用户 */
async function checkForUpdates(manual = true) {
  if (updateBusy) return;
  const btn = $('#updateBtn');
  updateBusy = true;
  if (btn) btn.disabled = true;
  setUpdateStatus(t('updateChecking'));
  try {
    const info = await window.api.checkUpdate();
    updateInfo = info;
    updateBusy = false;
    if (btn) btn.disabled = false;
    renderUpdateRow();
    if (info.hasUpdate && !manual) {
      toast(t('updateAvailableToast').replace('{v}', info.latest));
    }
  } catch (e) {
    updateInfo = null;
    updateBusy = false;
    if (btn) btn.disabled = false;
    const topBtn = $('#updateTopBtn');
    if (topBtn) topBtn.classList.remove('has-update');
    if (manual) {
      setUpdateStatus(t('updateCheckFailed') + errMsg(e));
      if (btn) btn.textContent = t('updateRetry');
    } else {
      renderUpdateRow();
    }
  }
}

/** 下载安装包并启动安装器（安装器会结束本进程） */
async function downloadAndInstallUpdate() {
  if (updateBusy || !updateInfo || !updateInfo.hasUpdate) return;
  const btn = $('#updateBtn');
  updateBusy = true;
  if (btn) btn.disabled = true;
  setUpdateStatus(t('updateDownloading') + ' 0%');
  try {
    await window.api.downloadUpdate(updateInfo.tag);
    setUpdateStatus(t('updateInstalling'));
    await window.api.installUpdate();
  } catch (e) {
    updateBusy = false;
    if (btn) btn.disabled = false;
    setUpdateStatus(t('updateDownloadFailed') + errMsg(e));
    btn.textContent = t('updateDownload');
  }
}

function onUpdateClick() {
  if (updateInfo && updateInfo.hasUpdate) downloadAndInstallUpdate();
  else checkForUpdates(true);
}

/** 选择语言 */
function selectLang(lang) {
  $('#langMenu').classList.add('hidden');
  $('#langBtn').focus();
  if (lang === window.i18n.getLang()) return;
  window.i18n.setLang(lang);
  applyI18n();
  renderAll(); // 重新渲染动态文案
}

// ── 初始化 ────────────────────────────────────────────────
async function init() {
  applyI18n();
  bindEvents();
  loadAppInfo();
  try {
    state.constants = await window.api.getConstants();
    state.maxDpi = state.constants.sensors.PAW3395.maxDpi;
  } catch (e) {
    state.constants = null;
  }
  loadLocalConfig();
  loadSettings();
  startBatteryAutoRefresh();
  renderAll();
  refreshDeviceState();
  // 启动 8 秒后静默检查更新（失败不打扰；发现新版本弹一次提示）
  setTimeout(() => checkForUpdates(false), 8000);
}

/** 侧栏底部：版本号 + 仓库链接 */
async function loadAppInfo() {
  let info = null;
  try {
    info = await window.api.getAppInfo();
  } catch (_) { /* 忽略 */ }
  const ver = $('#appVersion');
  if (ver) {
    ver.textContent = info && info.version ? 'v' + info.version : '';
    // 版本号兼作「关于」入口（Windows 已去掉原生菜单栏）
    ver.setAttribute('role', 'button');
    ver.setAttribute('tabindex', '0');
    ver.addEventListener('click', () => window.api.showAbout());
    ver.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        window.api.showAbout();
      }
    });
  }
  const link = $('#repoLink');
  if (link) {
    const url = (info && info.homepage) || 'https://github.com/HeHaoren/incott-mouse-app';
    link.addEventListener('click', () => window.api.openExternal(url));
    link.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        window.api.openExternal(url);
      }
    });
    link.setAttribute('tabindex', '0');
    link.setAttribute('role', 'button');
  }
}

/** 自绘标题栏：最大化状态与按钮图标同步 */
function applyMaximized(max) {
  document.body.classList.toggle('maximized', !!max);
  const icon = $('#winMaxIcon');
  if (icon) {
    icon.innerHTML = max
      ? '<rect x="3.4" y="4.6" width="4.6" height="4.6" rx="1"/><path d="M5.4 4.6V3.4h3.2v3.2"/>'
      : '<rect x="3" y="3" width="6" height="6" rx="1"/>';
  }
  const btn = $('#winMax');
  if (btn) btn.title = max ? '还原' : '最大化';
}

function bindEvents() {
  // 自绘窗口按钮（原生标题栏已去掉）
  $('#winMin').addEventListener('click', () => window.api.minimizeWindow());
  $('#winMax').addEventListener('click', () => window.api.toggleMaximizeWindow());
  $('#winClose').addEventListener('click', () => window.api.closeWindow());
  if (window.api.onMaximizedChange) window.api.onMaximizedChange(applyMaximized);
  window.api.isMaximized().then(applyMaximized);

  // 语言切换（图标按钮 + 下拉菜单）
  $('#langBtn').addEventListener('click', toggleLangMenu);
  document.querySelectorAll('.lang-option').forEach((opt) => {
    opt.addEventListener('click', () => selectLang(opt.dataset.lang));
  });
  // 设置面板
  $('#settingsBtn').addEventListener('click', toggleSettingsMenu);
  $('#setAutoLaunch').addEventListener('change', (e) =>
    onSettingChange({ autoLaunch: e.target.checked }, 'settingsAutoLaunch', e.target.checked));
  $('#setSilentStart').addEventListener('change', (e) =>
    onSettingChange({ silentStart: e.target.checked }, 'settingsSilentStart', e.target.checked));
  // 界面缩放：立即生效并落盘
  $('#setUiScale').addEventListener('change', async (e) => {
    applyUiScale(e.target.value);
    try {
      await window.api.setSettings({ uiScale: e.target.value });
    } catch (_) {
      toast(t('settingSaveFailed'), 'error');
    }
  });
  // 软件更新：顶栏按钮（展开设置并检查）/ 设置行按钮（检查 → 下载并安装）
  $('#updateTopBtn').addEventListener('click', openUpdatePanel);
  $('#updateBtn').addEventListener('click', onUpdateClick);
  if (window.api.onUpdateProgress) {
    window.api.onUpdateProgress((p) => {
      if (!updateBusy) return;
      setUpdateStatus(t('updateDownloading') + ' ' + (p.percent || 0) + '%');
    });
  }
  // 点击别处关闭语言/设置菜单（顶栏更新按钮也算「设置区」，否则它一展开就会被这里收起）
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.lang-wrap')) {
      $('#langMenu').classList.add('hidden');
    }
    if (!e.target.closest('.settings-wrap') && !e.target.closest('#updateTopBtn')) {
      $('#settingsMenu').classList.add('hidden');
    }
  });
  // 菜单键盘焦点：Esc 关闭并归还焦点，Tab 移出菜单区时关闭
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#langMenu').classList.contains('hidden')) {
      $('#langMenu').classList.add('hidden');
      $('#langBtn').focus();
    } else if (!$('#settingsMenu').classList.contains('hidden')) {
      $('#settingsMenu').classList.add('hidden');
      $('#settingsBtn').focus();
    }
  });
  document.addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    [['#langMenu', '.lang-wrap'], ['#settingsMenu', '.settings-wrap']].forEach(([menuSel, wrapSel]) => {
      const menu = $(menuSel);
      if (menu.classList.contains('hidden')) return;
      if (e.target.closest(menuSel) && (!to || !(to instanceof Element) || !to.closest(wrapSel))) {
        menu.classList.add('hidden');
      }
    });
  });
  if (window.i18n.onLangChanged) {
    window.i18n.onLangChanged(() => {
      applyI18n();
      renderAll();
    });
  }

  // 导航
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 连接
  $('#connectBtn').addEventListener('click', onConnect);
  $('#battery').addEventListener('click', onBatteryClick);
  $('#battery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onBatteryClick();
    }
  });
  // 设备主动上报的电量（官方主通道：推送即更新）
  window.api.onBattery(({ level, charging }) => {
    state.battery = level;
    state.batteryCharging = charging;
    renderBattery();
  });
  // 主进程 toast（如鼠标 DPI 键切换档位）
  window.api.onToast((msg) => showToast(msg));
  // 设备被拔出/接收器掉线：回到未连接状态并提示
  window.api.onDisconnected(() => {
    if (!state.connected) return;
    state.connected = false;
    state.modelInfo = null;
    state.battery = null;
    state.batteryCharging = false;
    renderDevice();
    renderLighting(); // 灯效页依赖 8K 接收器信息，断开后必须回落到禁用态
    setDeviceLabel(t('deviceDisconnected'), true);
    showToast(t('deviceDisconnected'));
  });
  $('#applyBtn').addEventListener('click', onApply);
  $('#addDpiBtn').addEventListener('click', onAddDpi);
  // 配置 / 宏 导入导出（官方 .ict / .icm 格式）
  $('#importBtn').addEventListener('click', onImportProfile);
  $('#exportBtn').addEventListener('click', onExportProfile);
  $('#macroImportBtn').addEventListener('click', onMacroImport);
  $('#macroExportBtn').addEventListener('click', onMacroExport);
  $('#xySplit').addEventListener('change', (e) => {
    state.xySplit = e.target.checked;
    if (state.xySplit) {
      // 开启 XY 轴单独调节时，Y 轴先同步成 X 轴的当前值，避免残留不一致
      state.dpiLevels.forEach((lv) => { lv.y = lv.x; });
    }
    renderDpi();
  });

  // 性能开关
  $('#ripple').addEventListener('change', (e) => (state.ripple = e.target.checked));
  $('#angleSnap').addEventListener('change', (e) => (state.angleSnap = e.target.checked));
  $('#motionSync').addEventListener('change', (e) => (state.motionSync = e.target.checked));
  $('#debounce').addEventListener('change', (e) => {
    state.debounce = clamp(parseInt(e.target.value) || 0, 0, 30);
  });
  // 节能调节：官方是 ± 逐档切换固定档位（10..900s）
  $('#sleepDown').addEventListener('click', () => stepSleep(-1));
  $('#sleepUp').addEventListener('click', () => stepSleep(1));

  // 板载配置：切换即把该份预设整套写入鼠标（硬件只有 1 份配置）
  document.querySelectorAll('.profile-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchProfile(parseInt(btn.dataset.profile, 10));
    });
  });
  // 鼠标上的配置切换键：硬件只改序号，界面把对应预设灌进去
  if (window.api.onProfile) {
    window.api.onProfile((idx) => {
      if (!state.connected || state.switching) return;
      // 自己写入后设备也会回显序号，2 位字段还会把第 5 个配置回显成 0，2.5s 内一律忽略
      if (Date.now() - lastWriteAt < 2500) return;
      if (idx === state.profile) return;
      switchProfile(idx);
    });
  }

  // 宏编辑器
  $('#macroLoopType').addEventListener('change', (e) => {
    state.macros[state.currentMacro].loopType = parseInt(e.target.value, 10);
    renderMacro();
  });
  $('#macroCycle').addEventListener('change', (e) => {
    state.macros[state.currentMacro].cycle = Math.max(1, parseInt(e.target.value) || 1);
  });
  $('#macroAddBtn').addEventListener('click', onMacroAddItem);
  $('#macroUploadBtn').addEventListener('click', onMacroUpload);
}

function switchTab(name) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
}

// ── 设备连接 ──────────────────────────────────────────────
async function onConnect() {
  if (state.connected) {
    await window.api.closeDevice();
    state.connected = false;
    state.modelInfo = null;
    state.battery = null;
    state.batteryCharging = false;
    renderDevice();
    renderLighting(); // 同上：断开后灯效选项要一起变灰
    setDeviceLabel(t('notConnected'));
    return;
  }
  showSpinner();
  setDeviceLabel(t('searching'));
  try {
    const list = await window.api.listDevices();
    if (list.length === 0) {
      hideSpinner();
      setDeviceLabel(t('deviceNotFound'), true);
      return;
    }
    setDeviceLabel(t('connecting'));
    // 不传 path：让主进程自动选可通信的 Col02 接口（插线时存在 Col01/Col02 两个接口）
    const st = await window.api.openDevice();
    state.connected = st.opened;
    state.isWireless = st.isWireless;
    applyModelInfo(st.modelInfo);
    setDeviceLabel(t('readingConfig'));
    renderDevice();

    // 一次性读回整套配置（配置序号 / DPI 档位与灯色 / 回报率 / LOD / 按键 / 节能时间）
    try {
      const snap = await window.api.readConfig();
      applyDeviceSnapshot(snap);
    } catch (e) {
      // 老固件不支持整套读取时退回逐条读（DPI 档位数 + 每档灯色）
      try {
        const dpi = await window.api.read('dpiLevel');
        if (dpi && dpi.levels > 0) syncDpiLevels(dpi.levels, dpi.current);
      } catch (_) {
        /* 读档位失败不阻塞连接 */
      }
    }
    renderAll();
    await refreshBattery();
    setDeviceLabel(st.isWireless ? t('connectedWireless') : t('connectedWired'));
    hideToast(); // 清掉可能残留的「已断开」提示
    hideSpinner();
  } catch (e) {
    hideSpinner();
    setDeviceLabel(t('connectFailed') + errMsg(e), true);
  }
}

/** 去掉 Electron IPC 包装前缀，只显示真正的原因 */
function errMsg(e) {
  return String(e && e.message ? e.message : e)
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '');
}

/** 应用 0x8F 型号信息：决定 DPI 上限（按传感器）与回报率可选范围（按 8K 接收器） */
function applyModelInfo(info) {
  state.modelInfo = info || null;
  if (info && state.constants) {
    state.maxDpi = info.sensor === state.constants.sensors.PAW3950.id
      ? state.constants.sensors.PAW3950.maxDpi
      : state.constants.sensors.PAW3395.maxDpi;
  } else if (state.isWireless && state.constants) {
    // 读不到型号信息时回退旧行为（无线按 PAW3950 上限）
    state.maxDpi = state.constants.sensors.PAW3950.maxDpi;
  }
  // 非 8K 接收器时高回报率不可选，当前值超限则回落
  if (info && !info.is8KReceiver && state.rate > 1000) state.rate = 1000;
  renderPerformance();
  renderLighting();
}

function showSpinner() {
  $('#deviceSpinner').classList.remove('hidden');
  $('#connectBtn').disabled = true;
}

function hideSpinner() {
  $('#deviceSpinner').classList.add('hidden');
  $('#connectBtn').disabled = false;
}

async function refreshDeviceState() {
  try {
    const st = await window.api.getState();
    if (st.opened) {
      state.connected = true;
      state.isWireless = st.isWireless;
      applyModelInfo(st.modelInfo);
      renderDevice();
    }
  } catch (_) { /* 未连接 */ }
}

function setDeviceLabel(text, isErr = false) {
  const el = $('#deviceLabel');
  el.textContent = text;
  el.title = text;
  el.style.color = isErr ? 'var(--red)' : '';
}

/** 顶栏显示型号 · 传感器 · 8K（来自 0x8F 型号信息，读不到则隐藏） */
function renderDeviceInfo() {
  const el = $('#deviceInfo');
  if (!state.connected || !state.modelInfo || !state.constants) {
    el.classList.add('hidden');
    return;
  }
  const info = state.modelInfo;
  const sensorName = info.sensor === state.constants.sensors.PAW3950.id ? 'PAW3950' : 'PAW3395';
  el.textContent = `${info.model} · ${sensorName}` + (info.is8KReceiver ? ' · 8K' : '');
  el.classList.remove('hidden');
}

function renderDevice() {
  $('#deviceStatus').className = 'status-dot ' + (state.connected ? 'on' : 'off');
  $('#connectBtn').textContent = state.connected ? t('disconnect') : t('connect');
  $('#applyBtn').disabled = !state.connected;
  renderDeviceInfo();
  renderBattery();
  renderDevicePanel();
}

/** DPI 页右侧设备面板：连接态、型号、回报率、当前档位、电量、板载配置 */
function renderDevicePanel() {
  const panel = $('#devicePanel');
  if (!panel) return;
  const on = state.connected && !!state.modelInfo;
  panel.classList.toggle('connected', on);

  const stateEl = $('#panelState');
  if (stateEl) {
    if (!state.connected) {
      stateEl.textContent = t('notConnected');
    } else if (state.modelInfo) {
      stateEl.textContent = state.modelInfo.model + (state.modelInfo.is8KReceiver ? ' · 8K' : '');
    } else {
      stateEl.textContent = state.isWireless ? t('connectedWireless') : t('connectedWired');
    }
  }

  const lv = state.dpiLevels[state.currentDpi];
  const rateEl = $('#statRate');
  if (rateEl) rateEl.textContent = state.rate ? `${state.rate} Hz` : '—';

  const dpiEl = $('#statDpi');
  if (dpiEl) {
    if (!lv) {
      dpiEl.textContent = '—';
    } else if (state.xySplit && lv.x !== lv.y) {
      dpiEl.textContent = `${lv.x} / ${lv.y}`;
    } else {
      dpiEl.textContent = String(lv.x);
    }
  }

  const batEl = $('#statBattery');
  if (batEl) {
    if (!state.connected || state.battery == null) {
      batEl.textContent = '—';
      batEl.classList.remove('warn', 'bad');
    } else {
      batEl.textContent = `${state.battery}%` + (state.batteryCharging ? ' · 充电中' : '');
      batEl.classList.toggle('warn', !state.batteryCharging && state.battery <= 60 && state.battery > 25);
      batEl.classList.toggle('bad', !state.batteryCharging && state.battery <= 25);
    }
  }

  const profEl = $('#statProfile');
  if (profEl) profEl.textContent = state.connected ? `${(state.profile || 0) + 1} / ${profileCount()}` : '—';

  // 面板灯效颜色跟随当前档位色（仅连接时点亮，未连接保持熄灭）
  if (on) {
    panel.classList.add('dpi-colored');
    panel.style.setProperty('--led-color', dpiColorAt(state.currentDpi));
  } else {
    panel.classList.remove('dpi-colored');
  }
}

// ── 电量 ───────────────────────────────────────────────────
let batteryRefreshTimer = null;

/** 启动电量定时自动刷新（每 60s，仅在连接时读取） */
function startBatteryAutoRefresh() {
  if (batteryRefreshTimer) return;
  batteryRefreshTimer = setInterval(() => {
    if (state.connected) refreshBattery();
  }, 60000);
}

async function refreshBattery() {
  if (!state.connected) return;
  try {
    const val = await window.api.read('battery'); // { level, charging }
    state.battery = val.level;
    state.batteryCharging = val.charging;
    renderBattery();
  } catch (_) {
    /* 读电量失败静默（保留上次值） */
  }
}

/** 点击电量图标：刷新并弹提示（电量 + 充电状态） */
async function onBatteryClick() {
  await refreshBattery();
  if (state.battery != null) {
    const charging = state.batteryCharging ? ` · ${t('chargingTag')}⚡` : '';
    showToast(`${t('batteryLabel')} ${state.battery}%${charging}`);
  }
}

// 最近一次「整套写入鼠标」的时间：用于忽略自身写入引起的配置序号回显
let lastWriteAt = 0;

// ── Toast ──────────────────────────────────────────────────
let toastTimer = null;
let toastHideTimer = null;

function showToast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  void el.offsetWidth; // 强制重排，保证 display:none → 显示时过渡生效
  el.classList.add('show');
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  toastTimer = setTimeout(hideToast, 2000); // 2 秒后自动消失
}

/** 淡出后隐藏（快速收起，连接成功等场景也用它清残留） */
function hideToast() {
  const el = $('#toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.classList.remove('show');
  clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => el.classList.add('hidden'), 160);
}

function renderBattery() {
  const el = $('#battery');
  if (!state.connected || state.battery == null) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.title = t('batteryHint');
  $('#batteryVal').textContent = state.battery;
  // 三段颜色：>60 绿，25~60 黄，≤25 红（对齐官方驱动的电量显示规则）
  el.classList.remove('high', 'mid', 'low');
  if (state.battery > 60) el.classList.add('high');
  else if (state.battery > 25) el.classList.add('mid');
  else el.classList.add('low');
  el.classList.toggle('charging', !!state.batteryCharging);
  renderDevicePanel();
}

// ── DPI ───────────────────────────────────────────────────
function onAddDpi() {
  const last = state.dpiLevels[state.dpiLevels.length - 1];
  const v = last ? last.x : 800;
  state.dpiLevels.push({ x: v, y: v, color: '#4da3ff' });
  renderDpi();
}

function onRemoveDpi(i) {
  if (state.dpiLevels.length <= 1) return;
  state.dpiLevels.splice(i, 1);
  if (state.currentDpi >= state.dpiLevels.length) state.currentDpi = state.dpiLevels.length - 1;
  renderDpi();
}

function renderDpi() {
  const list = $('#dpiList');
  list.innerHTML = '';
  state.dpiLevels.forEach((lv, i) => {
    const card = document.createElement('div');
    card.className = 'dpi-card' + (i === state.currentDpi ? ' current' : '');
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-pressed', i === state.currentDpi ? 'true' : 'false');

    const idx = document.createElement('div');
    idx.className = 'dpi-index';
    idx.textContent = i + 1;

    const body = document.createElement('div');
    body.className = 'dpi-body';

    if (state.xySplit) {
      body.appendChild(dpiRow('X', i, 'x', dpiColorAt(i)));
      body.appendChild(dpiRow('Y', i, 'y', dpiColorAt(i)));
    } else {
      body.appendChild(dpiRow('', i, 'x', dpiColorAt(i)));
    }

    // 档位标识色：只影响界面（滑杆/面板灯点）和 .ict 存档，不写到鼠标 ——
    // 鼠标指示灯的颜色由固件按「回报率 / 电量」决定（官方说明书 §5.4），没有"按 DPI 档位
    // 显示不同颜色"这回事；命令 2 的 buf[4..6] 能写能回读，但固件只存不用（2026-11-15 A/B 证实）。
    const swatch = document.createElement('span');
    swatch.className = 'dpi-swatch';
    swatch.style.setProperty('--sw', dpiColorAt(i));
    swatch.title = t('dpiColorNote');
    swatch.setAttribute('aria-hidden', 'true');

    const rm = document.createElement('button');
    rm.className = 'dpi-remove';
    rm.textContent = '✕';
    rm.title = t('removeDpi');
    rm.addEventListener('click', () => onRemoveDpi(i));

    card.appendChild(idx);
    card.appendChild(body);
    card.appendChild(swatch);
    card.appendChild(rm);
    card.addEventListener('click', (e) => {
      if (e.target.closest('.dpi-remove') || e.target.closest('.dpi-swatch') ||
          e.target.closest('.dpi-value-input') || e.target.closest('.dpi-slider')) return;
      state.currentDpi = i;
      renderDpi();
    });
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        state.currentDpi = i;
        renderDpi();
        const cards = $('#dpiList').querySelectorAll('.dpi-card');
        if (cards[i]) cards[i].focus();
      }
    });

    list.appendChild(card);
  });

  renderDevicePanel();
}

function dpiRow(label, dpiIndex, axis, color) {
  const row = document.createElement('div');
  row.className = 'dpi-row';

  if (label) {
    const lab = document.createElement('span');
    lab.className = 'dpi-axis-label';
    lab.textContent = label;
    row.appendChild(lab);
  }

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'dpi-value-input';
  input.min = 50;
  input.max = state.maxDpi;
  input.step = 50;
  input.value = state.dpiLevels[dpiIndex][axis];
  input.title = t('dpiInputHint');

  const applyInput = () => {
    let v = parseInt(input.value);
    if (isNaN(v)) v = state.dpiLevels[dpiIndex][axis]; // 非法输入回退原值
    v = snapDpi(v);
    state.dpiLevels[dpiIndex][axis] = v;
    slider.value = v;
    input.value = v;
  };
  input.addEventListener('change', applyInput); // 失焦/上下箭头
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyInput(); // 回车立即应用输入
      input.blur();
    }
  });

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'dpi-slider';
  slider.min = 50;
  slider.max = state.maxDpi;
  slider.step = 50;
  slider.value = state.dpiLevels[dpiIndex][axis];
  slider.style.accentColor = color;
  slider.addEventListener('input', () => {
    const v = snapDpi(parseInt(slider.value));
    state.dpiLevels[dpiIndex][axis] = v;
    input.value = v;
  });

  row.appendChild(input);
  row.appendChild(slider);
  return row;
}

function snapDpi(v) {
  return clamp(Math.round(v / 50) * 50, 50, state.maxDpi);
}

/**
 * DPI 下限归一：小于 50（含 0、负数、非数字）一律按 50 处理。
 * 协议最小 DPI 是 50（硬件值 0）：0 会让 dpiToHw 返回 -1，整次 apply 抛 RangeError。
 * .ict 导入、旧存档、下发三处都过这一道。
 */
function dpiFloor(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n < 50 ? 50 : n;
}

/** 将 UI 档位数量对齐到鼠标实际档位数（截断或补齐），并同步当前档位 */
function syncDpiLevels(levels, current) {
  const last = state.dpiLevels[state.dpiLevels.length - 1] || { x: 800, y: 800, color: '#4da3ff' };
  while (state.dpiLevels.length < levels) {
    state.dpiLevels.push({ x: last.x, y: last.y, color: dpiColorAt(state.dpiLevels.length) });
  }
  if (state.dpiLevels.length > levels) {
    state.dpiLevels.length = levels;
  }
  if (current >= 0 && current < state.dpiLevels.length) {
    state.currentDpi = current;
  }
}

// ── 性能 ───────────────────────────────────────────────────
// 性能模式：官方 UI 顺序 电竞|标准|节能，协议值 3/2/1（0x84 sub5）
const SENSOR_MODES = [
  { value: 3, key: 'modeEsports', descKey: 'modeEsportsDesc' },
  { value: 2, key: 'modeStandard', descKey: 'modeStandardDesc' },
  { value: 1, key: 'modeEco', descKey: 'modeEcoDesc' },
];

function renderPerformance() {
  if (!state.constants) return;
  // 轮询率：非 8K 接收器（含有线）只提供 ≤1000Hz（硬件会钳制，实机验证）
  const gateHighRates = state.modelInfo && !state.modelInfo.is8KReceiver;
  // 从小到大排序展示（协议码表顺序是 1000/500/250/125/8000/4000/2000，直接渲染不直观）
  const rates = (gateHighRates
    ? state.constants.rateTable.filter((r) => r.hz <= 1000)
    : state.constants.rateTable
  ).slice().sort((a, b) => a.hz - b.hz);
  const rateList = $('#rateList');
  rateList.innerHTML = '';
  rates.forEach((r) => {
    const chip = document.createElement('button');
    chip.className = 'rate-chip' + (r.hz === state.rate ? ' selected' : '');
    chip.textContent = r.hz + ' Hz';
    chip.addEventListener('click', () => {
      state.rate = r.hz;
      renderPerformance();
    });
    rateList.appendChild(chip);
  });
  // 8K 门控提示
  const old = $('#rate8kNote');
  if (old) old.remove();
  if (gateHighRates) {
    const note = document.createElement('div');
    note.id = 'rate8kNote';
    note.className = 'opt-desc warn';
    note.textContent = t('rate8kOnly');
    rateList.after(note);
  }

  // LOD
  const lodList = $('#lodList');
  lodList.innerHTML = '';
  state.constants.lodTable.forEach((v, i) => {
    const chip = document.createElement('button');
    chip.className = 'rate-chip' + (i === state.lod ? ' selected' : '');
    chip.textContent = v + ' mm';
    chip.addEventListener('click', () => {
      state.lod = i;
      renderPerformance();
    });
    lodList.appendChild(chip);
  });

  // 性能模式（官方 0x84 sub5：3=电竞 2=标准 1=节能）
  const modeList = $('#modeList');
  if (modeList) {
    const esportsBlocked = state.rate > 1000; // 官方：8K/2000Hz+ 已是最佳性能，不能开电竞
    modeList.innerHTML = '';
    SENSOR_MODES.forEach((m) => {
      const chip = document.createElement('button');
      const disabled = m.value === 3 && esportsBlocked;
      chip.className = 'rate-chip' + (m.value === state.sensorMode ? ' selected' : '');
      chip.textContent = t(m.key);
      chip.disabled = disabled;
      chip.title = disabled ? t('mode8kNote') : t(m.descKey);
      chip.addEventListener('click', () => {
        if (disabled) return;
        state.sensorMode = m.value;
        renderPerformance();
      });
      modeList.appendChild(chip);
    });
  }
  const modeDesc = $('#modeDesc');
  if (modeDesc) {
    const cur = SENSOR_MODES.find((m) => m.value === state.sensorMode) || SENSOR_MODES[1];
    const blocked = state.rate > 1000;
    modeDesc.textContent = blocked ? t('mode8kNote') : t(cur.descKey);
    modeDesc.className = 'opt-desc' + (blocked ? ' warn' : '');
  }
}

// ── 灯效（接收器灯效）─────────────────────────────────────
// 说明文案取自官方网页驱动（text_sc-v106.js msg75/76/77），颜色对照同源
const LED_DESC_KEYS = { 0: 'ledRateDesc', 1: 'ledBatteryDesc', 2: 'ledLowDesc' };
const LED_COLORS = {
  red: '#F0616B', blue: '#5B9BFF', yellow: '#F2CE4B', orange: '#F0851F',
  purple: '#A98BF0', green: '#35C98A', white: '#F2EEFA',
};
// [标签, 颜色键, 附加类]；标签为 null 时用 i18n 的 ledChargingSwatch
const LED_SWATCHES = {
  0: [['125Hz', 'red'], ['250Hz', 'blue'], ['500Hz', 'yellow'], ['1000Hz', 'orange'],
      ['2000Hz', 'purple'], ['4000Hz', 'green'], ['8000Hz', 'white']],
  1: [['100%', 'green'], ['66%', 'yellow'], ['33%', 'orange'], ['0%', 'red']],
  2: [[null, 'red', 'blink']],
};
const LED_GRADIENT = { 1: ['green', 'yellow', 'orange', 'red'] };

function renderLighting() {
  if (!state.constants || !state.constants.ledModeTable) return;
  const list = $('#ledList');
  if (!list) return;
  const note = $('#ledNote');
  const desc = $('#ledDesc');
  const gradient = $('#ledGradient');
  const swatches = $('#ledSwatches');

  // 仅 8K 接收器支持（实机验证命令 8 只对 8K 接收器有效）
  const supported = !!(state.modelInfo && state.modelInfo.is8KReceiver);
  const mode = LED_DESC_KEYS[state.receiverLed] ? state.receiverLed : 0;

  list.innerHTML = '';
  state.constants.ledModeTable.forEach((m) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'led-mode' + (m.value === state.receiverLed ? ' selected' : '');
    item.dataset.mode = String(m.value);
    item.disabled = !supported;
    item.setAttribute('aria-pressed', String(m.value === state.receiverLed));

    const dot = document.createElement('span');
    dot.className = 'led-mode-dot';
    dot.setAttribute('aria-hidden', 'true');

    const title = document.createElement('span');
    title.textContent = t(m.key);

    item.append(dot, title);
    item.addEventListener('click', () => {
      if (!supported) return;
      state.receiverLed = m.value;
      renderLighting();
    });
    list.appendChild(item);
  });

  // 选中模式对应的颜色说明（官方原文）
  if (desc) desc.textContent = t(LED_DESC_KEYS[mode]);
  if (gradient) {
    const stops = LED_GRADIENT[mode];
    gradient.style.display = stops ? '' : 'none';
    if (stops) {
      const step = 100 / (stops.length - 1);
      gradient.style.background = `linear-gradient(90deg, ${stops
        .map((c, i) => `${LED_COLORS[c]} ${Math.round(i * step)}%`)
        .join(', ')})`;
    }
  }
  if (swatches) {
    swatches.innerHTML = '';
    (LED_SWATCHES[mode] || []).forEach(([label, colorKey, extra]) => {
      const chip = document.createElement('span');
      chip.className = 'led-swatch' + (extra ? ' ' + extra : '');
      chip.style.setProperty('--sw', LED_COLORS[colorKey]);
      const dot = document.createElement('i');
      dot.setAttribute('aria-hidden', 'true');
      chip.append(dot, document.createTextNode(label || t('ledChargingSwatch')));
      swatches.appendChild(chip);
    });
  }

  if (note) {
    if (!state.connected) note.textContent = t('ledNeedConnect');
    else if (!supported) note.textContent = t('ledNeed8K');
    else note.textContent = '';
  }
}

// ── 板载配置（5 份 PC 端预设）──────────────────────────────
// 实测（2026-11-15，G24 有线）：把 [6,9,idx] 依次写到 0..5 再回读，DPI / 键位 /
// 回报率 / 节能时间完全一致，只有序号标记变化 —— 硬件只有 1 份配置。
// 官方桌面驱动的 5 个「配置」(Language/ch.xml str_profile1..5) 都是 PC 端预设，
// 切换时把整套配置灌进鼠标。本工具按同样语义实现。
const DEFAULT_DPI_LEVELS = [
  { x: 400, y: 400, color: dpiColorAt(0) },
  { x: 800, y: 800, color: dpiColorAt(1) },
  { x: 1600, y: 1600, color: dpiColorAt(2) },
  { x: 2400, y: 2400, color: dpiColorAt(3) },
  { x: 3200, y: 3200, color: dpiColorAt(4) },
  { x: 6400, y: 6400, color: dpiColorAt(5) },
];

const DEFAULT_BUTTONS = [
  { type: 'mouse', value: 'LEFT' },
  { type: 'mouse', value: 'RIGHT' },
  { type: 'mouse', value: 'MIDDLE' },
  { type: 'mouse', value: 'BACK' },
  { type: 'mouse', value: 'FORWARD' },
  { type: 'mouse', value: 'DPI_LOOP' },
];

function profileCount() {
  return state.constants && state.constants.profileCount ? state.constants.profileCount : 5;
}

/** 一份未改动过的配置：默认 DPI 档位与颜色（用户没改过时界面就显示这些） */
function defaultProfile() {
  return {
    dpiLevels: DEFAULT_DPI_LEVELS.map((lv) => ({ ...lv })),
    currentDpi: 0,
    xySplit: false,
    rate: 1000,
    lod: 0,
    ripple: false,
    angleSnap: false,
    motionSync: true,
    debounce: 8,
    sensorMode: 2,
    sleepTime: 60,
    receiverLed: 0,
    buttons: DEFAULT_BUTTONS.map((b) => ({ ...b })),
  };
}

/** 把界面上的当前编辑状态存回当前配置槽 */
function captureProfile() {
  const p = state.profiles[state.profile];
  if (!p) return;
  p.dpiLevels = state.dpiLevels.map((lv) => ({ ...lv }));
  p.currentDpi = state.currentDpi;
  p.xySplit = state.xySplit;
  p.rate = state.rate;
  p.lod = state.lod;
  p.ripple = state.ripple;
  p.angleSnap = state.angleSnap;
  p.motionSync = state.motionSync;
  p.debounce = state.debounce;
  p.sensorMode = state.sensorMode;
  p.sleepTime = state.sleepTime;
  p.receiverLed = state.receiverLed;
  p.buttons = state.buttons.map((b) => ({ ...b }));
}

/** 把某份配置载入界面状态 */
function loadProfileData(p) {
  if (!p) return;
  if (Array.isArray(p.dpiLevels) && p.dpiLevels.length) {
    state.dpiLevels = p.dpiLevels.map((lv) => ({ ...lv }));
  }
  state.currentDpi = clamp(p.currentDpi ?? 0, 0, Math.max(state.dpiLevels.length - 1, 0));
  state.xySplit = !!p.xySplit;
  if (p.rate) state.rate = p.rate;
  if (p.lod != null) state.lod = clamp(p.lod, 0, 2);
  state.ripple = !!p.ripple;
  state.angleSnap = !!p.angleSnap;
  state.motionSync = !!p.motionSync;
  if (p.sensorMode != null) state.sensorMode = clamp(p.sensorMode, 1, 3);
  if (p.debounce != null) state.debounce = clamp(p.debounce, 0, 30);
  if (p.sleepTime != null) state.sleepTime = p.sleepTime;
  if (p.receiverLed != null) state.receiverLed = clamp(p.receiverLed, 0, 2);
  state.buttons = (p.buttons || DEFAULT_BUTTONS).map((b) => ({ ...b }));
}

/** 补齐 5 个配置槽（旧版本只有单份配置时迁移到第 1 槽） */
function ensureProfiles() {
  const n = profileCount();
  if (!Array.isArray(state.profiles)) state.profiles = [];
  while (state.profiles.length < n) state.profiles.push(defaultProfile());
  if (state.profiles.length > n) state.profiles.length = n;
  state.profile = clamp(state.profile || 0, 0, n - 1);
}

/**
 * 切换配置：保存当前槽 → 载入目标槽 → （已连接时）把整套配置写入鼠标。
 * 硬件只有一个配置位，所以「切换」必须真正下发，否则鼠标行为不会变。
 */
async function switchProfile(index, opts = {}) {
  const n = profileCount();
  const i = clamp(index, 0, n - 1);
  if (state.switching) return;
  if (i === state.profile && !opts.force) {
    renderProfile();
    return;
  }
  captureProfile();
  state.profile = i;
  loadProfileData(state.profiles[i]);
  renderAll();
  saveLocalConfig();

  if (!state.connected) return;
  state.switching = true;
  lastWriteAt = Date.now();
  renderProfile();
  flashStatus(t('profileSwitching').replace('{n}', i + 1));
  try {
    await window.api.apply(buildApplyOps());
    flashStatus(t('profileSwitched').replace('{n}', i + 1));
  } catch (e) {
    flashStatus(t('applyFailed') + errMsg(e), true);
  } finally {
    state.switching = false;
    renderProfile();
  }
}

// ── 键码反解（读设备配置时把 32 位键码还原成界面选项）─────────
function hidNameFor(hidCode) {
  if (!state.constants) return null;
  for (const [name, code] of Object.entries(state.constants.hidKeyCodes)) {
    if (code === hidCode) return name;
  }
  return null;
}

/**
 * 32 位键码 → { type, value }。
 * 反解不出来时返回 null，调用方保留默认值并记下 raw，应用时原样写回（避免抹掉用户的自定义键）。
 */
function decodeKeyCode(code32) {
  const C = state.constants;
  if (!C) return null;
  const code = code32 >>> 0;
  for (const [name, val] of Object.entries(C.mouseKeyCodes || {})) {
    if ((val >>> 0) === code) return { type: 'mouse', value: name };
  }
  for (const [name, val] of Object.entries(C.mediaKeyCodes || {})) {
    if ((val >>> 0) === code) return { type: 'media', value: name };
  }
  if ((code & 0xff) === 9) return { type: 'macro', value: String(code >>> 16) };
  if ((code & 0xff) === 0x80) {
    // 普通键盘键：(hidCode << 8) | 0x80
    const name = hidNameFor((code >> 8) & 0xff);
    if (name) return { type: 'keyboard', value: name };
  }
  if ((code & 0xff) === 0) {
    // 带修饰键：(hidCode << 16) | (modifier << 8)，界面只显示主键
    const name = hidNameFor((code >> 16) & 0xff);
    if (name) return { type: 'keyboard', value: name };
  }
  return null;
}

/** 把设备读回的 6 个键码写到 state.buttons（反解不了的保留默认 + raw） */
function applyButtonCodes(codes) {
  if (!Array.isArray(codes) || !codes.length) return;
  codes.forEach((code, i) => {
    if (i >= state.buttons.length) return;
    const decoded = decodeKeyCode(code);
    state.buttons[i] = decoded
      ? { ...decoded, raw: undefined }
      : { ...DEFAULT_BUTTONS[i], raw: code >>> 0 };
  });
}

/**
 * 把 readConfig 的快照写进当前使用的配置槽并载入界面。
 * 颜色为 #000000 表示该档没存过颜色（固件默认），此时保留预设里的颜色。
 */
function applyDeviceSnapshot(snap) {
  if (!snap) return;
  const slot = clamp(typeof snap.profileIndex === 'number' ? snap.profileIndex : 0, 0, profileCount() - 1);
  state.profile = slot;
  const p = state.profiles[slot] || defaultProfile();

  if (Array.isArray(snap.slots) && snap.slots.length) {
    // 0x82 读命令只有 slot、没有轴参数，回读不出 Y 轴（官方驱动同样只写不读 Y）。
    // 因此这里只认设备回读的 X：若它和本地记录一致，说明 Y 没被外部改过，保留本地 Y；
    // 若 X 变了（在别的驱动/机器上改过），两轴按一致处理，避免保留过期的 Y。
    p.dpiLevels = snap.slots.map((s, i) => {
      const prev = p.dpiLevels[i];
      const y = prev && prev.x === s.dpi ? prev.y : s.dpi;
      return { x: s.dpi, y, color: dpiColorAt(i) }; // 颜色固定，忽略设备里存的旧字节
    });
  }
  if (snap.current != null) p.currentDpi = snap.current;
  if (snap.rate) p.rate = snap.rate;
  if (snap.lod != null) p.lod = snap.lod;
  if (snap.ripple != null) p.ripple = snap.ripple;
  if (snap.angleSnap != null) p.angleSnap = snap.angleSnap;
  if (snap.motionSync != null) p.motionSync = snap.motionSync;
  if (snap.sensorMode != null) p.sensorMode = clamp(snap.sensorMode, 1, 3);
  if (snap.debounce != null) p.debounce = snap.debounce;
  if (snap.sleepTime != null) p.sleepTime = snap.sleepTime;
  if (snap.receiverLed != null) p.receiverLed = snap.receiverLed;

  state.profiles[slot] = p;
  loadProfileData(p);
  applyButtonCodes(snap.buttons);
}

function renderProfile() {
  const n = profileCount();
  const bar = $('#profileBar');
  if (bar) bar.title = t('profileNotOnHardware');
  document.querySelectorAll('.profile-btn').forEach((btn) => {
    const i = parseInt(btn.dataset.profile, 10);
    btn.classList.toggle('active', i === state.profile);
    btn.disabled = state.switching;
    btn.title = t('profileName').replace('{n}', i + 1);
    btn.setAttribute('aria-pressed', i === state.profile ? 'true' : 'false');
    btn.hidden = i >= n;
  });
}

// ── 节能调节（± 步进，官方档位）────────────────────────────
function sleepSteps() {
  return (state.constants && state.constants.sleepSteps) || [10, 20, 30, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900];
}

/** 任意秒数吸附到最近的官方档位（导入配置 / 读回设备时用） */
function nearestSleepStep(sec) {
  const steps = sleepSteps();
  const n = Number(sec);
  if (!Number.isFinite(n)) return steps[0];
  return steps.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
}

function renderSleep() {
  const steps = sleepSteps();
  const i = steps.indexOf(state.sleepTime);
  const el = $('#sleepValue');
  if (el) el.textContent = String(state.sleepTime);
  const down = $('#sleepDown');
  const up = $('#sleepUp');
  if (down) {
    down.disabled = i <= 0;
    down.title = t('sleepLess');
    down.setAttribute('aria-label', t('sleepLess'));
  }
  if (up) {
    up.disabled = i < 0 || i >= steps.length - 1;
    up.title = t('sleepMore');
    up.setAttribute('aria-label', t('sleepMore'));
  }
}

function stepSleep(dir) {
  const steps = sleepSteps();
  let i = steps.indexOf(state.sleepTime);
  if (i < 0) i = steps.reduce((a, b, idx) => (Math.abs(b - state.sleepTime) < Math.abs(steps[a] - state.sleepTime) ? idx : a), 0);
  const next = clamp(i + dir, 0, steps.length - 1);
  if (next === i) return;
  state.sleepTime = steps[next];
  renderSleep();
}

// ── 按键映射 ───────────────────────────────────────────────
const BUTTON_NAMES_KEYS = ['keyLeft', 'keyRight', 'keyMiddle', 'keyBack', 'keyForward', 'keyDpi'];
const BUTTON_TYPES = [
  { id: 'mouse', labelKey: 'typeSystem' },
  { id: 'keyboard', labelKey: 'typeKeyboard' },
  { id: 'media', labelKey: 'typeMedia' },
  { id: 'macro', labelKey: 'typeMacro' },
];

function renderButtons() {
  const list = $('#buttonList');
  list.innerHTML = '';
  state.buttons.forEach((btn, i) => {
    const row = document.createElement('div');
    row.className = 'button-row';

    const name = document.createElement('span');
    name.className = 'button-name';
    name.textContent = t(BUTTON_NAMES_KEYS[i]);

    const typeSel = document.createElement('select');
    typeSel.className = 'button-select';
    typeSel.style.width = '120px';
    BUTTON_TYPES.forEach((tt) => {
      const opt = document.createElement('option');
      opt.value = tt.id;
      opt.textContent = t(tt.labelKey);
      opt.selected = btn.type === tt.id;
      typeSel.appendChild(opt);
    });
    typeSel.addEventListener('change', () => {
      state.buttons[i] = { type: typeSel.value, value: defaultForType(typeSel.value) };
      renderButtons();
    });

    const valueSel = document.createElement('select');
    valueSel.className = 'button-select';
    valueSel.appendChild(buildButtonOptions(btn.type, btn.value));
    valueSel.addEventListener('change', () => {
      state.buttons[i].value = valueSel.value;
      state.buttons[i].raw = undefined; // 用户改过就不再原样写回
    });

    row.appendChild(name);
    row.appendChild(typeSel);
    row.appendChild(valueSel);
    list.appendChild(row);
  });
}

function defaultForType(type) {
  if (type === 'mouse') return 'LEFT';
  if (type === 'keyboard') return 'KeyA';
  if (type === 'media') return 'PLAY_PAUSE';
  return '0';
}

function buildButtonOptions(type, selectedValue) {
  const frag = document.createDocumentFragment();
  const label = (code) => (window.keynames ? window.keynames.keyLabel(type, code) : code);
  if (type === 'mouse') {
    state.constants.mouseKeys.forEach((k) => {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = label(k);
      opt.selected = k === selectedValue;
      frag.appendChild(opt);
    });
  } else if (type === 'keyboard') {
    Object.keys(state.constants.hidKeyCodes).forEach((k) => {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = label(k);
      opt.selected = k === selectedValue;
      frag.appendChild(opt);
    });
  } else if (type === 'media') {
    state.constants.mediaKeys.forEach((k) => {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = label(k);
      opt.selected = k === selectedValue;
      frag.appendChild(opt);
    });
  } else if (type === 'macro') {
    for (let m = 0; m < 10; m++) {
      const opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = t('macroPrefix') + (m + 1);
      opt.selected = String(m) === selectedValue;
      frag.appendChild(opt);
    }
  }
  return frag;
}

// ── 宏编辑器 ───────────────────────────────────────────────
let macroKeySelectInited = false;

function initMacroKeySelect() {
  if (!state.constants) return;
  macroKeySelectInited = true;
  const sel = $('#macroKeySel');
  const prev = sel.value;
  sel.innerHTML = '';
  Object.entries(state.constants.hidKeyCodes).forEach(([name, code]) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = window.keynames ? window.keynames.keyLabel('keyboard', name) : name;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function renderMacro() {
  const slots = $('#macroSlots');
  slots.innerHTML = '';
  state.macros.forEach((m, i) => {
    const btn = document.createElement('button');
    btn.className =
      'macro-slot' +
      (i === state.currentMacro ? ' active' : '') +
      (m.items.length ? ' has-content' : '');
    btn.textContent = i + 1;
    btn.title = m.items.length ? `${m.name}（${m.items.length} ${t('itemUnit')}）` : m.name;
    btn.addEventListener('click', () => {
      state.currentMacro = i;
      renderMacro();
    });
    slots.appendChild(btn);
  });

  const m = state.macros[state.currentMacro];
  $('#macroLoopType').value = String(m.loopType);
  $('#macroCycle').value = m.cycle;
  $('#macroCycleWrap').style.display = m.loopType === 2 ? '' : 'none';
  renderMacroItems(m);
}

function renderMacroItems(m) {
  const list = $('#macroItems');
  list.innerHTML = '';
  if (m.items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'macro-empty';
    empty.textContent = t('macroEmpty');
    list.appendChild(empty);
    return;
  }
  m.items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'macro-item';

    const idx = document.createElement('span');
    idx.className = 'macro-item-index';
    idx.textContent = i + 1;

    const dir = document.createElement('span');
    dir.className = 'macro-item-dir ' + (it.press ? 'press' : 'release');
    dir.textContent = it.press ? t('pressDir') : t('releaseDir');

    const key = document.createElement('span');
    key.className = 'macro-item-key';
    const rawName = codeToKeyName(it.keyCode);
    key.textContent = window.keynames ? window.keynames.keyLabel('keyboard', rawName) : rawName;

    const delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.min = 0;
    delayInput.max = 60000;
    delayInput.value = it.delay;
    delayInput.title = t('delayMs');
    delayInput.addEventListener('change', () => {
      it.delay = Math.max(0, parseInt(delayInput.value) || 0);
    });
    const delayWrap = document.createElement('span');
    delayWrap.className = 'macro-item-delay';
    delayWrap.appendChild(delayInput);

    const rm = document.createElement('button');
    rm.className = 'macro-item-remove';
    rm.textContent = '✕';
    rm.title = t('removeAction');
    rm.addEventListener('click', () => {
      m.items.splice(i, 1);
      renderMacro();
    });

    row.appendChild(idx);
    row.appendChild(dir);
    row.appendChild(key);
    row.appendChild(delayWrap);
    row.appendChild(rm);
    list.appendChild(row);
  });
}

function codeToKeyName(code) {
  for (const [name, c] of Object.entries(state.constants.hidKeyCodes)) {
    if (c === code) return name;
  }
  return '0x' + code.toString(16);
}

function onMacroAddItem() {
  const keyCode = parseInt($('#macroKeySel').value, 10);
  if (isNaN(keyCode)) return;
  const press = $('#macroPressSel').value === '1';
  const delay = Math.max(0, parseInt($('#macroDelay').value) || 0);
  const m = state.macros[state.currentMacro];
  if (m.items.length >= 70) {
    flashMacroStatus(t('macroFull'), true);
    return;
  }
  m.items.push({ press, keyCode, delay });
  renderMacro();
}

async function onMacroUpload() {
  if (!state.connected) {
    flashMacroStatus(t('pleaseConnect'), true);
    return;
  }
  const btn = $('#macroUploadBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  const m = state.macros[state.currentMacro];
  const status = $('#macroStatus');
  status.textContent = t('uploading');
  status.title = status.textContent;
  status.className = 'apply-status';
  try {
    await window.api.uploadMacro({
      slot: m.slot,
      loopType: m.loopType,
      cycle: m.cycle,
      items: m.items.map((it) => ({ press: it.press, keyCode: it.keyCode, delay: it.delay })),
    });
    status.textContent = t('uploaded');
    status.title = status.textContent;
    status.className = 'apply-status ok';
    clearTimeout(macroStatusTimer);
    macroStatusTimer = setTimeout(() => {
      status.textContent = '';
      status.title = '';
      status.className = 'apply-status';
    }, 4000);
    saveLocalConfig();
  } catch (e) {
    status.textContent = t('uploadFailed') + e.message;
    status.title = status.textContent;
    status.className = 'apply-status err';
  } finally {
    btn.disabled = !state.connected;
  }
}

let macroStatusTimer = null;

function flashMacroStatus(text, isErr) {
  const s = $('#macroStatus');
  clearTimeout(macroStatusTimer);
  s.textContent = text;
  s.title = text;
  s.className = 'apply-status ' + (isErr ? 'err' : '');
  if (!isErr) {
    macroStatusTimer = setTimeout(() => {
      s.textContent = '';
      s.title = '';
      s.className = 'apply-status';
    }, 4000);
  }
}

// ── 应用 ───────────────────────────────────────────────────
async function onApply() {
  if (!state.connected) {
    flashStatus(t('pleaseConnect'), true);
    return;
  }
  const btn = $('#applyBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  const status = $('#applyStatus');
  status.textContent = t('applying');
  status.title = status.textContent;
  status.className = 'apply-status';

  try {
    const ops = buildApplyOps();
    lastWriteAt = Date.now(); // 写入回显的配置序号要忽略（见 onProfile）
    await window.api.apply(ops);
    status.textContent = t('applied');
    status.title = status.textContent;
    status.className = 'apply-status ok';
    clearTimeout(applyStatusTimer);
    applyStatusTimer = setTimeout(() => {
      status.textContent = '';
      status.title = '';
      status.className = 'apply-status';
    }, 4000);
    saveLocalConfig();
  } catch (e) {
    status.textContent = t('applyFailed') + e.message;
    status.title = status.textContent;
    status.className = 'apply-status err';
  } finally {
    btn.disabled = !state.connected;
  }
}

function buildApplyOps() {
  const ops = [];

  // 按键映射（按矩阵位置 index）
  state.buttons.forEach((btn, i) => {
    // 读设备时反解不出来的键码原样写回，避免把用户自定义的键抹成默认值
    if (btn.raw != null) {
      ops.push({ action: 'setKeyRaw', args: [i, btn.raw] });
      return;
    }
    ops.push({ action: 'setKey', args: [i, btn.type, btn.value] });
  });

  // DPI 档位值（传实际 DPI，主进程 setDpi 内部转硬件值）
  // 每档的灯色也走同一条命令的 buf[4..6]，官方驱动恒填 0（这就是"改灯色不生效"的原因）
  state.dpiLevels.forEach((lv, i) => {
    const color = dpiColorAt(i);
    // 下发前再兜一次底：低于 50 的 DPI 一律按 50，绝不让 0 进命令
    const x = dpiFloor(lv.x, 800);
    const y = dpiFloor(lv.y, x);
    if (state.xySplit && x !== y) {
      ops.push({ action: 'setDpi', args: [i, x, 1, color] }); // X 轴
      ops.push({ action: 'setDpi', args: [i, y, 2, color] }); // Y 轴
    } else {
      ops.push({ action: 'setDpi', args: [i, x, 0, color] });
    }
  });

  // DPI 档位切换
  ops.push({ action: 'setDpiLevel', args: [state.dpiLevels.length, state.currentDpi] });

  // 轮询率
  ops.push({ action: 'setRate', args: [state.rate] });

  // 性能模式（协议 apply 顺序：回报率之后）
  ops.push({ action: 'setSensorMode', args: [state.sensorMode] });

  // 传感器高级
  ops.push({ action: 'setRipple', args: [state.ripple] });
  ops.push({ action: 'setAngleSnap', args: [state.angleSnap] });
  ops.push({ action: 'setMotionSync', args: [state.motionSync] });
  ops.push({ action: 'setLod', args: [state.lod] });

  // 去抖
  ops.push({ action: 'setDebounce', args: [state.debounce] });

  // 休眠时间
  ops.push({ action: 'setSleepTime', args: [state.sleepTime] });

  // Profile
  ops.push({ action: 'setProfile', args: [state.profile] });

  // 接收器指示灯（仅 8K 接收器）
  if (state.modelInfo && state.modelInfo.is8KReceiver) {
    ops.push({ action: 'setReceiverLed', args: [state.receiverLed] });
  }

  return ops;
}

function dpiToHwSafe(dpi) {
  return Math.round((dpi - 50) / 50);
}

// ── 配置导入导出（.ict，兼容官方网页驱动格式）────────────────
function buildProfileExport() {
  return {
    name: t('profileName').replace('{n}', state.profile + 1),
    sensor: state.modelInfo ? state.modelInfo.sensor : undefined,
    rate: state.rate,
    lod: state.lod,
    sensorMode: state.sensorMode,
    angleSnap: state.angleSnap,
    ripple: state.ripple,
    motionSync: state.motionSync,
    debounce: state.debounce,
    sleepTime: state.sleepTime,
    receiverLed: state.receiverLed,
    currentDpi: state.currentDpi,
    dpiLevels: state.dpiLevels.map((lv, i) => ({ ...lv, color: dpiColorAt(i) })),
    buttons: state.buttons,
  };
}

async function onExportProfile() {
  try {
    const res = await window.api.exportProfile(buildProfileExport());
    if (!res.canceled) flashStatus(t('configExported'));
  } catch (e) {
    flashStatus(t('exportFailed') + e.message, true);
  }
}

async function onImportProfile() {
  try {
    const res = await window.api.importProfile();
    if (res.canceled) return;
    applyImportedProfile(res.profile);
    renderAll();
    saveLocalConfig(); // 导入的配置写入当前槽并持久化
    flashStatus(t('configImported'));
  } catch (e) {
    flashStatus(t('importFailed') + errMsg(e), true);
  }
}

function applyImportedProfile(p) {
  if (Array.isArray(p.dpiLevels) && p.dpiLevels.length) {
    // 低于 50 的 DPI 统一按 50 处理（importProfile 已归一，这里再兜一次底）
    state.dpiLevels = p.dpiLevels.map((lv, i) => {
      const x = dpiFloor(lv.x, 800);
      return { x, y: dpiFloor(lv.y, x), color: dpiColorAt(i) };
    });
    // X/Y 不一致时自动打开 XY 分离显示（用归一后的值判断）
    state.xySplit = state.dpiLevels.some((lv) => lv.x !== lv.y);
  }
  state.currentDpi = clamp(p.currentDpi ?? 0, 0, state.dpiLevels.length - 1);
  if (p.rate) state.rate = p.rate;
  if (p.lod != null) state.lod = clamp(p.lod, 0, 2);
  state.angleSnap = !!p.angleSnap;
  state.ripple = !!p.ripple;
  state.motionSync = !!p.motionSync;
  if (p.sensorMode != null) state.sensorMode = clamp(p.sensorMode, 1, 3);
  if (p.sensorMode != null) state.sensorMode = clamp(p.sensorMode, 1, 3);
  if (p.debounce != null) state.debounce = clamp(p.debounce, 0, 30);
  // 节能调节只有固定档位，吸附到最近的官方值
  if (p.sleepTime != null) state.sleepTime = nearestSleepStep(p.sleepTime);
  if (Array.isArray(p.buttons) && p.buttons.length === 6) state.buttons = p.buttons;
  if (p.receiverLed != null) state.receiverLed = clamp(p.receiverLed, 0, 2);
  // 非 8K 接收器回落超范围回报率
  if (state.modelInfo && !state.modelInfo.is8KReceiver && state.rate > 1000) state.rate = 1000;
}

// ── 宏库导入导出（.icm，兼容官方网页驱动格式）────────────────
async function onMacroExport() {
  try {
    const res = await window.api.exportMacros(state.macros);
    if (!res.canceled) flashMacroStatus(t('macrosExported'));
  } catch (e) {
    flashMacroStatus(t('exportFailed') + e.message, true);
  }
}

async function onMacroImport() {
  try {
    const res = await window.api.importMacros();
    if (res.canceled) return;
    // 导入的宏按顺序占用槽位 0..n-1，其余槽位重置为空（与官方宏库替换语义一致）
    const imported = res.macros.slice(0, 10);
    state.macros = [];
    for (let s = 0; s < 10; s++) {
      const m = imported[s];
      state.macros.push(m
        ? { slot: s, name: m.name || (t('macroPrefix') + (s + 1)), loopType: m.loopType, cycle: m.cycle, items: m.items }
        : { slot: s, name: t('macroPrefix') + (s + 1), loopType: 2, cycle: 1, items: [] });
    }
    state.currentMacro = 0;
    renderMacro();
    saveLocalConfig();
    flashMacroStatus(t('macrosImported') + imported.length + t('macroUnit'));
  } catch (e) {
    flashMacroStatus(t('importFailed') + e.message, true);
  }
}

let applyStatusTimer = null;

function flashStatus(text, isErr) {
  const s = $('#applyStatus');
  clearTimeout(applyStatusTimer);
  s.textContent = text;
  s.title = text;
  s.className = 'apply-status ' + (isErr ? 'err' : '');
  if (!isErr) {
    applyStatusTimer = setTimeout(() => {
      s.textContent = '';
      s.title = '';
      s.className = 'apply-status';
    }, 4000);
  }
}

// ── 本地配置持久化 ─────────────────────────────────────────
/** 旧格式（单份配置）→ 一份完整预设，缺的字段用默认值补齐 */
function normalizeProfile(p) {
  const base = defaultProfile();
  if (!p || typeof p !== 'object') return base;
  const out = { ...base };
  if (Array.isArray(p.dpiLevels) && p.dpiLevels.length) {
    // 旧存档里低于 50 的 DPI（含 0/负数）统一按 50 处理
    out.dpiLevels = p.dpiLevels.map((lv, i) => {
      const x = dpiFloor(lv.x, base.dpiLevels[0].x);
      return {
        x,
        y: dpiFloor(lv.y, x),
        color: dpiColorAt(i), // 颜色固定为官方六色，不受旧存档影响
      };
    });
  }
  if (p.currentDpi != null) out.currentDpi = clamp(p.currentDpi, 0, out.dpiLevels.length - 1);
  ['xySplit', 'ripple', 'angleSnap', 'motionSync'].forEach((k) => {
    if (p[k] != null) out[k] = !!p[k];
  });
  if (p.rate) out.rate = p.rate;
  if (p.lod != null) out.lod = clamp(p.lod, 0, 2);
  if (p.debounce != null) out.debounce = clamp(p.debounce, 0, 30);
  if (p.sensorMode != null) out.sensorMode = clamp(p.sensorMode, 1, 3);
  if (p.sleepTime != null) out.sleepTime = p.sleepTime;
  if (p.receiverLed != null) out.receiverLed = clamp(p.receiverLed, 0, 2);
  if (Array.isArray(p.buttons) && p.buttons.length === 6) out.buttons = p.buttons.map((b) => ({ ...b }));
  return out;
}

function loadLocalConfig() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem('incott-config'));
  } catch (_) { /* 忽略 */ }

  if (saved) {
    if (Array.isArray(saved.profiles) && saved.profiles.length) {
      state.profiles = saved.profiles.map(normalizeProfile);
      if (saved.profile != null) state.profile = saved.profile;
    } else {
      // 0.4 及更早只存了一份配置 —— 迁移到第 1 槽，其余槽位保持官方默认
      state.profiles = [normalizeProfile(saved)];
    }
    if (Array.isArray(saved.macros)) state.macros = saved.macros;
    if (saved.currentMacro != null) state.currentMacro = saved.currentMacro;
  }

  ensureProfiles();
  loadProfileData(state.profiles[state.profile]);
  state.buttons = state.buttons.length ? state.buttons : DEFAULT_BUTTONS.map((b) => ({ ...b }));

  if (state.macros.length === 0) {
    state.macros = [];
    for (let s = 0; s < 10; s++) {
      state.macros.push({ slot: s, name: t('macroPrefix') + (s + 1), loopType: 2, cycle: 1, items: [] });
    }
  }
}

function saveLocalConfig() {
  captureProfile(); // 界面上的改动先落回当前槽，否则切配置/刷新会丢
  localStorage.setItem('incott-config', JSON.stringify({
    profiles: state.profiles,
    profile: state.profile,
    macros: state.macros,
    currentMacro: state.currentMacro,
  }));
}

function renderAll() {
  renderDevice();
  renderDpi();
  renderPerformance();
  renderLighting();
  renderProfile();
  renderButtons();
  initMacroKeySelect();
  renderMacro();
  renderSleep();
  // 恢复开关状态
  $('#xySplit').checked = state.xySplit;
  $('#ripple').checked = state.ripple;
  $('#angleSnap').checked = state.angleSnap;
  $('#motionSync').checked = state.motionSync;
  $('#debounce').value = state.debounce;
  renderUpdateRow(); // 语言切换后更新行文案跟随
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// 首帧先按自动值缩放，避免读完设置才跳一下
applyUiScale('auto');
init();

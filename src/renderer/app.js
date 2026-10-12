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
  profile: 0,
  buttons: [], // [{ type: 'mouse'|'keyboard'|'media'|'macro', value }]
};

const $ = (sel) => document.querySelector(sel);

// ── 初始化 ────────────────────────────────────────────────
async function init() {
  bindEvents();
  try {
    state.constants = await window.api.getConstants();
    state.maxDpi = state.constants.sensors.PAW3395.maxDpi;
  } catch (e) {
    state.constants = null;
  }
  loadLocalConfig();
  renderAll();
  refreshDeviceState();
}

function bindEvents() {
  // 导航
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 连接
  $('#connectBtn').addEventListener('click', onConnect);
  $('#applyBtn').addEventListener('click', onApply);
  $('#addDpiBtn').addEventListener('click', onAddDpi);
  $('#xySplit').addEventListener('change', (e) => {
    state.xySplit = e.target.checked;
    renderDpi();
  });

  // 性能开关
  $('#ripple').addEventListener('change', (e) => (state.ripple = e.target.checked));
  $('#angleSnap').addEventListener('change', (e) => (state.angleSnap = e.target.checked));
  $('#motionSync').addEventListener('change', (e) => (state.motionSync = e.target.checked));
  $('#debounce').addEventListener('change', (e) => {
    state.debounce = clamp(parseInt(e.target.value) || 0, 0, 30);
  });

  // Profile
  document.querySelectorAll('.profile-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.profile = parseInt(btn.dataset.profile);
      renderProfile();
    });
  });
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
    renderDevice();
    return;
  }
  setDeviceLabel('正在连接…');
  try {
    const list = await window.api.listDevices();
    if (list.length === 0) {
      setDeviceLabel('未找到鼠标，请插入后重试', true);
      return;
    }
    const st = await window.api.openDevice(list[0].path);
    state.connected = st.opened;
    state.isWireless = st.isWireless;
    if (state.isWireless) state.maxDpi = state.constants.sensors.PAW3950.maxDpi;
    setDeviceLabel(st.isWireless ? '已连接（无线）' : '已连接（有线）');
    renderDevice();
    renderDpi();
  } catch (e) {
    setDeviceLabel('连接失败：' + e.message, true);
  }
}

async function refreshDeviceState() {
  try {
    const st = await window.api.getState();
    if (st.opened) {
      state.connected = true;
      state.isWireless = st.isWireless;
      renderDevice();
    }
  } catch (_) { /* 未连接 */ }
}

function setDeviceLabel(text, isErr = false) {
  $('#deviceLabel').textContent = text;
  $('#deviceLabel').style.color = isErr ? 'var(--red)' : '';
}

function renderDevice() {
  $('#deviceStatus').className = 'status-dot ' + (state.connected ? 'on' : 'off');
  $('#connectBtn').textContent = state.connected ? '断开' : '连接鼠标';
  $('#applyBtn').disabled = !state.connected;
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

    const idx = document.createElement('div');
    idx.className = 'dpi-index';
    idx.textContent = i + 1;

    const body = document.createElement('div');
    body.className = 'dpi-body';

    if (state.xySplit) {
      body.appendChild(dpiRow('X', i, 'x', lv.color));
      body.appendChild(dpiRow('Y', i, 'y', lv.color));
    } else {
      body.appendChild(dpiRow('', i, 'x', lv.color));
    }

    const color = document.createElement('input');
    color.type = 'color';
    color.className = 'dpi-color';
    color.value = lv.color;
    color.addEventListener('input', (e) => {
      state.dpiLevels[i].color = e.target.value;
    });

    const rm = document.createElement('button');
    rm.className = 'dpi-remove';
    rm.textContent = '✕';
    rm.title = '删除档位';
    rm.addEventListener('click', () => onRemoveDpi(i));

    card.appendChild(idx);
    card.appendChild(body);
    card.appendChild(color);
    card.appendChild(rm);
    card.addEventListener('click', (e) => {
      if (e.target.closest('.dpi-remove') || e.target.closest('.dpi-color')) return;
      state.currentDpi = i;
      renderDpi();
    });

    list.appendChild(card);
  });
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
  input.addEventListener('change', () => {
    let v = parseInt(input.value);
    if (isNaN(v)) v = 50;
    v = snapDpi(v);
    state.dpiLevels[dpiIndex][axis] = v;
    slider.value = v;
    input.value = v;
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

// ── 性能 ───────────────────────────────────────────────────
function renderPerformance() {
  // 轮询率
  const rateList = $('#rateList');
  rateList.innerHTML = '';
  state.constants.rateTable.forEach((r) => {
    const chip = document.createElement('button');
    chip.className = 'rate-chip' + (r.hz === state.rate ? ' selected' : '');
    chip.textContent = r.hz + ' Hz';
    chip.addEventListener('click', () => {
      state.rate = r.hz;
      renderPerformance();
    });
    rateList.appendChild(chip);
  });

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
}

// ── Profile ────────────────────────────────────────────────
function renderProfile() {
  document.querySelectorAll('.profile-btn').forEach((btn) => {
    btn.classList.toggle('active', parseInt(btn.dataset.profile) === state.profile);
  });
}

// ── 按键映射 ───────────────────────────────────────────────
const BUTTON_NAMES = ['左键', '右键', '中键', '后退', '前进', 'DPI 键'];
const BUTTON_TYPES = [
  { id: 'mouse', label: '鼠标功能' },
  { id: 'keyboard', label: '键盘按键' },
  { id: 'media', label: '多媒体' },
  { id: 'macro', label: '宏' },
];

function renderButtons() {
  const list = $('#buttonList');
  list.innerHTML = '';
  state.buttons.forEach((btn, i) => {
    const row = document.createElement('div');
    row.className = 'button-row';

    const name = document.createElement('span');
    name.className = 'button-name';
    name.textContent = BUTTON_NAMES[i] || `按键 ${i + 1}`;

    const typeSel = document.createElement('select');
    typeSel.className = 'button-select';
    typeSel.style.width = '120px';
    BUTTON_TYPES.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label;
      opt.selected = btn.type === t.id;
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
  if (type === 'mouse') {
    state.constants.mouseKeys.forEach((k) => {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = k;
      opt.selected = k === selectedValue;
      frag.appendChild(opt);
    });
  } else if (type === 'keyboard') {
    Object.keys(state.constants.hidKeyCodes).forEach((k) => {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = k;
      opt.selected = k === selectedValue;
      frag.appendChild(opt);
    });
  } else if (type === 'media') {
    state.constants.mediaKeys.forEach((k) => {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = k;
      opt.selected = k === selectedValue;
      frag.appendChild(opt);
    });
  } else if (type === 'macro') {
    for (let m = 0; m < 10; m++) {
      const opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = `宏 ${m + 1}`;
      opt.selected = String(m) === selectedValue;
      frag.appendChild(opt);
    }
  }
  return frag;
}

// ── 应用 ───────────────────────────────────────────────────
async function onApply() {
  if (!state.connected) {
    flashStatus('请先连接鼠标', true);
    return;
  }
  const status = $('#applyStatus');
  status.textContent = '正在应用…';
  status.className = 'apply-status';

  try {
    const ops = buildApplyOps();
    await window.api.apply(ops);
    status.textContent = '✓ 已应用';
    status.className = 'apply-status ok';
    saveLocalConfig();
  } catch (e) {
    status.textContent = '应用失败：' + e.message;
    status.className = 'apply-status err';
  }
}

function buildApplyOps() {
  const ops = [];
  const dpiHw = state.dpiLevels.map((lv) => ({
    x: dpiToHwSafe(lv.x),
    y: dpiToHwSafe(lv.y),
  }));

  // 按键映射（按矩阵位置 index）
  state.buttons.forEach((btn, i) => {
    ops.push({ action: 'setKey', args: [i, btn.type, btn.value] });
  });

  // DPI 档位值
  state.dpiLevels.forEach((lv, i) => {
    const hwX = dpiHw[i].x;
    if (state.xySplit && lv.x !== lv.y) {
      const hwY = dpiHw[i].y;
      ops.push({ action: 'setDpi', args: [i, hwX, 1] }); // X 轴
      ops.push({ action: 'setDpi', args: [i, hwY, 2] }); // Y 轴
    } else {
      ops.push({ action: 'setDpi', args: [i, hwX, 0] });
    }
  });

  // DPI 档位切换
  ops.push({ action: 'setDpiLevel', args: [state.dpiLevels.length, state.currentDpi] });

  // 轮询率
  ops.push({ action: 'setRate', args: [state.rate] });

  // 传感器高级
  ops.push({ action: 'setRipple', args: [state.ripple] });
  ops.push({ action: 'setAngleSnap', args: [state.angleSnap] });
  ops.push({ action: 'setMotionSync', args: [state.motionSync] });
  ops.push({ action: 'setLod', args: [state.lod] });

  // 去抖
  ops.push({ action: 'setDebounce', args: [state.debounce] });

  // Profile
  ops.push({ action: 'setProfile', args: [state.profile] });

  return ops;
}

function dpiToHwSafe(dpi) {
  return Math.round((dpi - 50) / 50);
}

function flashStatus(text, isErr) {
  const s = $('#applyStatus');
  s.textContent = text;
  s.className = 'apply-status ' + (isErr ? 'err' : '');
  setTimeout(() => { s.textContent = ''; }, 3000);
}

// ── 本地配置持久化 ─────────────────────────────────────────
function loadLocalConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('encott-config'));
    if (saved) {
      if (Array.isArray(saved.dpiLevels) && saved.dpiLevels.length) state.dpiLevels = saved.dpiLevels;
      if (saved.currentDpi != null) state.currentDpi = saved.currentDpi;
      if (saved.xySplit != null) state.xySplit = saved.xySplit;
      if (saved.rate != null) state.rate = saved.rate;
      if (saved.lod != null) state.lod = saved.lod;
      if (saved.ripple != null) state.ripple = saved.ripple;
      if (saved.angleSnap != null) state.angleSnap = saved.angleSnap;
      if (saved.motionSync != null) state.motionSync = saved.motionSync;
      if (saved.debounce != null) state.debounce = saved.debounce;
      if (saved.profile != null) state.profile = saved.profile;
      if (Array.isArray(saved.buttons)) state.buttons = saved.buttons;
    }
  } catch (_) { /* 忽略 */ }

  if (state.dpiLevels.length === 0) {
    state.dpiLevels = [
      { x: 400, y: 400, color: '#ff4d4d' },
      { x: 800, y: 800, color: '#4da3ff' },
      { x: 1600, y: 1600, color: '#3fb950' },
      { x: 2400, y: 2400, color: '#ffd700' },
      { x: 3200, y: 3200, color: '#22d3ee' },
      { x: 6400, y: 6400, color: '#ff4dff' },
    ];
  }

  if (state.buttons.length === 0) {
    state.buttons = [
      { type: 'mouse', value: 'LEFT' },
      { type: 'mouse', value: 'RIGHT' },
      { type: 'mouse', value: 'MIDDLE' },
      { type: 'mouse', value: 'BACK' },
      { type: 'mouse', value: 'FORWARD' },
      { type: 'mouse', value: 'DPI_LOOP' },
    ];
  }
}

function saveLocalConfig() {
  localStorage.setItem('encott-config', JSON.stringify({
    dpiLevels: state.dpiLevels,
    currentDpi: state.currentDpi,
    xySplit: state.xySplit,
    rate: state.rate,
    lod: state.lod,
    ripple: state.ripple,
    angleSnap: state.angleSnap,
    motionSync: state.motionSync,
    debounce: state.debounce,
    profile: state.profile,
    buttons: state.buttons,
  }));
}

function renderAll() {
  renderDevice();
  renderDpi();
  renderPerformance();
  renderProfile();
  renderButtons();
  // 恢复开关状态
  $('#xySplit').checked = state.xySplit;
  $('#ripple').checked = state.ripple;
  $('#angleSnap').checked = state.angleSnap;
  $('#motionSync').checked = state.motionSync;
  $('#debounce').value = state.debounce;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

init();

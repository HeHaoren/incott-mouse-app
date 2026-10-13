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
  macros: [], // [{ slot, name, loopType, cycle, items: [{press, keyCode, delay}] }]
  currentMacro: 0,
};

const $ = (sel) => document.querySelector(sel);
const t = (key) => window.i18n.t(key);

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
  $('#langMenu').classList.toggle('hidden');
}

/** 选择语言 */
function selectLang(lang) {
  $('#langMenu').classList.add('hidden');
  if (lang === window.i18n.getLang()) return;
  window.i18n.setLang(lang);
  applyI18n();
  renderAll(); // 重新渲染动态文案
}

// ── 初始化 ────────────────────────────────────────────────
async function init() {
  applyI18n();
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
  // 语言切换（图标按钮 + 下拉菜单）
  $('#langBtn').addEventListener('click', toggleLangMenu);
  document.querySelectorAll('.lang-option').forEach((opt) => {
    opt.addEventListener('click', () => selectLang(opt.dataset.lang));
  });
  // 点击别处关闭语言菜单
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.lang-wrap')) {
      $('#langMenu').classList.add('hidden');
    }
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
  $('#applyBtn').addEventListener('click', onApply);
  $('#addDpiBtn').addEventListener('click', onAddDpi);
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

  // Profile
  document.querySelectorAll('.profile-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.profile = parseInt(btn.dataset.profile);
      renderProfile();
    });
  });

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
    renderDevice();
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
    const st = await window.api.openDevice(list[0].path);
    state.connected = st.opened;
    state.isWireless = st.isWireless;
    if (state.isWireless) state.maxDpi = state.constants.sensors.PAW3950.maxDpi;
    setDeviceLabel(t('readingConfig'));
    renderDevice();

    // 读取鼠标实际的 DPI 档位配置（档位数 + 当前档位），对齐 UI
    try {
      const dpi = await window.api.read('dpiLevel');
      if (dpi && dpi.levels > 0) {
        syncDpiLevels(dpi.levels, dpi.current);
      }
    } catch (e) {
      /* 读档位失败不阻塞连接 */
    }
    renderDpi();
    setDeviceLabel(st.isWireless ? t('connectedWireless') : t('connectedWired'));
    hideSpinner();
  } catch (e) {
    hideSpinner();
    setDeviceLabel(t('connectFailed') + e.message, true);
  }
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
  $('#connectBtn').textContent = state.connected ? t('disconnect') : t('connect');
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
    rm.title = t('removeDpi');
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

/** 将 UI 档位数量对齐到鼠标实际档位数（截断或补齐），并同步当前档位 */
function syncDpiLevels(levels, current) {
  const last = state.dpiLevels[state.dpiLevels.length - 1] || { x: 800, y: 800, color: '#4da3ff' };
  while (state.dpiLevels.length < levels) {
    state.dpiLevels.push({ x: last.x, y: last.y, color: last.color });
  }
  if (state.dpiLevels.length > levels) {
    state.dpiLevels.length = levels;
  }
  if (current >= 0 && current < state.dpiLevels.length) {
    state.currentDpi = current;
  }
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
  if (macroKeySelectInited || !state.constants) return;
  macroKeySelectInited = true;
  const sel = $('#macroKeySel');
  Object.entries(state.constants.hidKeyCodes).forEach(([name, code]) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    sel.appendChild(opt);
  });
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
    key.textContent = codeToKeyName(it.keyCode);

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
  const m = state.macros[state.currentMacro];
  const status = $('#macroStatus');
  status.textContent = t('uploading');
  status.className = 'apply-status';
  try {
    await window.api.uploadMacro({
      slot: m.slot,
      loopType: m.loopType,
      cycle: m.cycle,
      items: m.items.map((it) => ({ press: it.press, keyCode: it.keyCode, delay: it.delay })),
    });
    status.textContent = t('uploaded');
    status.className = 'apply-status ok';
    saveLocalConfig();
  } catch (e) {
    status.textContent = t('uploadFailed') + e.message;
    status.className = 'apply-status err';
  }
}

function flashMacroStatus(text, isErr) {
  const s = $('#macroStatus');
  s.textContent = text;
  s.className = 'apply-status ' + (isErr ? 'err' : '');
  setTimeout(() => { s.textContent = ''; }, 3000);
}

// ── 应用 ───────────────────────────────────────────────────
async function onApply() {
  if (!state.connected) {
    flashStatus(t('pleaseConnect'), true);
    return;
  }
  const status = $('#applyStatus');
  status.textContent = t('applying');
  status.className = 'apply-status';

  try {
    const ops = buildApplyOps();
    await window.api.apply(ops);
    status.textContent = t('applied');
    status.className = 'apply-status ok';
    saveLocalConfig();
  } catch (e) {
    status.textContent = t('applyFailed') + e.message;
    status.className = 'apply-status err';
  }
}

function buildApplyOps() {
  const ops = [];

  // 按键映射（按矩阵位置 index）
  state.buttons.forEach((btn, i) => {
    ops.push({ action: 'setKey', args: [i, btn.type, btn.value] });
  });

  // DPI 档位值（传实际 DPI，主进程 setDpi 内部转硬件值）
  state.dpiLevels.forEach((lv, i) => {
    if (state.xySplit && lv.x !== lv.y) {
      ops.push({ action: 'setDpi', args: [i, lv.x, 1] }); // X 轴
      ops.push({ action: 'setDpi', args: [i, lv.y, 2] }); // Y 轴
    } else {
      ops.push({ action: 'setDpi', args: [i, lv.x, 0] });
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
    const saved = JSON.parse(localStorage.getItem('incott-config'));
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
      if (Array.isArray(saved.macros)) state.macros = saved.macros;
      if (saved.currentMacro != null) state.currentMacro = saved.currentMacro;
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

  if (state.macros.length === 0) {
    state.macros = [];
    for (let s = 0; s < 10; s++) {
      state.macros.push({ slot: s, name: t('macroPrefix') + (s + 1), loopType: 2, cycle: 1, items: [] });
    }
  }
}

function saveLocalConfig() {
  localStorage.setItem('incott-config', JSON.stringify({
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
    macros: state.macros,
    currentMacro: state.currentMacro,
  }));
}

function renderAll() {
  renderDevice();
  renderDpi();
  renderPerformance();
  renderProfile();
  renderButtons();
  initMacroKeySelect();
  renderMacro();
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

/** 安装程序渲染层：状态机 + 进度 */

const $ = (sel) => document.querySelector(sel);

const state = {
  dir: '',
  version: '',
  installing: false,
  installedDir: '',
};

function show(id) {
  document.querySelectorAll('.state').forEach((el) => el.classList.toggle('active', el.id === id));
}

function fmtMB(bytes) {
  if (!bytes) return '—';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

async function boot() {
  const info = await window.setup.info();
  state.version = info.version;
  state.dir = info.defaultDir;

  $('#optSub').textContent = `版本 ${info.version} · 为 G23 / G24 / G29 等因科特鼠标提供独立配置工具`;
  $('#dirInput').value = state.dir;
  $('#spaceText').textContent = `需要 ${fmtMB(info.payloadBytes)} 磁盘空间`;

  if (info.existing) {
    $('#existingHint').textContent = info.existing.version
      ? `检测到已安装 ${info.existing.version}，将继续安装并覆盖旧版本`
      : '检测到已有安装，将继续安装并覆盖旧版本';
  }

  // 进度回调
  window.setup.onProgress((p) => {
    if (typeof p.percent === 'number') {
      $('#barFill').style.width = Math.min(100, Math.max(0, p.percent)) + '%';
      $('#percentText').textContent = Math.round(p.percent) + '%';
    }
    if (p.detail) $('#detailText').textContent = p.detail;
  });
}

async function startInstall() {
  if (state.installing) return;
  state.installing = true;

  show('state-progress');
  $('#barFill').style.width = '0%';
  $('#percentText').textContent = '0%';
  $('#detailText').textContent = '准备中…';

  const res = await window.setup.install({
    dir: state.dir,
    desktopShortcut: $('#deskChk').checked,
    startMenuShortcut: $('#menuChk').checked,
    launch: false, // 完成页再决定是否启动
  });

  state.installing = false;
  $('#barFill').style.width = '100%';
  $('#percentText').textContent = '100%';

  if (res.ok) {
    state.installedDir = res.dir;
    $('#doneSub').textContent = `已安装到 ${res.dir}`;
    $('#doneWarn').textContent = (res.warnings || []).join('；');
    setTimeout(() => show('state-done'), 220);
  } else if (res.canceled) {
    $('#backBtn').textContent = '返回';
    show('state-options');
  } else {
    $('#errorText').textContent = res.error || '未知错误';
    show('state-error');
  }
}

// ── 事件 ──

$('#minBtn').addEventListener('click', () => window.setup.minimize());
$('#closeBtn').addEventListener('click', async () => {
  if (state.installing) await window.setup.cancel();
  window.setup.close();
});

$('#browseBtn').addEventListener('click', async () => {
  const r = await window.setup.browse(state.dir);
  if (!r.canceled) {
    state.dir = r.dir;
    $('#dirInput').value = r.dir;
    $('#existingHint').textContent = '';
  }
});

$('#installBtn').addEventListener('click', startInstall);

$('#cancelBtn').addEventListener('click', async () => {
  $('#cancelBtn').disabled = true;
  $('#detailText').textContent = '正在取消…';
  await window.setup.cancel();
  $('#cancelBtn').disabled = false;
});

$('#retryBtn').addEventListener('click', () => {
  show('state-options');
  startInstall();
});

$('#backBtn').addEventListener('click', () => show('state-options'));

$('#openFolderBtn').addEventListener('click', () => {
  if (state.installedDir) window.setup.openFolder(state.installedDir);
});

$('#finishBtn').addEventListener('click', async () => {
  if ($('#launchChk').checked && state.installedDir) {
    await window.setup.launch(state.installedDir);
  }
  window.setup.close();
});

// Esc 关闭（安装中先取消）
document.addEventListener('keydown', async (e) => {
  if (e.key !== 'Escape') return;
  if (state.installing) await window.setup.cancel();
  window.setup.close();
});

boot();

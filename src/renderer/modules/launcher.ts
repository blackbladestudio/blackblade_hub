import type { AppConfig } from '../../types/config';
import type {
  LauncherManifest,
  BuildInfo,
  GameVariant,
  DownloadProgress,
  LauncherState,
  InstalledBuild,
} from '../../types/launcher';
import { toast, setStatus } from '../utils';

let currentVariant: GameVariant = 'Shipping';
let manifest: LauncherManifest | null = null;
let state: LauncherState | null = null;
let isInstalling = false;
let getConfigRef: (() => AppConfig) | null = null;

export function initLauncher(getConfig: () => AppConfig): void {
  getConfigRef = getConfig;

  // Main-screen game card: play area launches directly, manage button opens page
  document.getElementById('launch-game-play')!.addEventListener('click', handlePlayFromCard);
  document.getElementById('btn-game-manage')!.addEventListener('click', (e) => {
    e.stopPropagation();
    showLauncherPage();
  });

  // Launcher page controls
  document.getElementById('launcher-back')!.addEventListener('click', hideLauncherPage);
  document.getElementById('launcher-btn-refresh')!.addEventListener('click', () =>
    refreshLauncherData(),
  );

  document.querySelectorAll('#launcher-tabs .launcher-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      selectVariant(tab.getAttribute('data-variant') as GameVariant);
    });
  });

  document.getElementById('launcher-btn-install')!.addEventListener('click', handleInstall);
  document.getElementById('launcher-btn-launch')!.addEventListener('click', handleLaunch);
  document.getElementById('launcher-btn-update')!.addEventListener('click', handleInstall);
  document.getElementById('launcher-btn-uninstall')!.addEventListener('click', handleUninstall);
  document.getElementById('launcher-btn-browse-dir')!.addEventListener('click', handleBrowseDir);

  window.studioHub.onLauncherProgress(handleProgress);

  // Load initial state to update the game card on the main screen
  refreshGameCardStatus();
}

/**
 * Update the small status text on the main-screen game card.
 * Called on init and after every install/uninstall.
 */
export async function refreshGameCardStatus(): Promise<void> {
  state = await window.studioHub.launcherGetState();
  const statusEl = document.getElementById('launch-game-status')!;

  const firstInstalled = (['Shipping', 'Development', 'Testing'] as GameVariant[])
    .find((v) => state?.installed[v]);

  if (firstInstalled && state?.installed[firstInstalled]) {
    const b = state.installed[firstInstalled]!;
    statusEl.textContent = `${firstInstalled}  ${b.version} (${b.buildNumber})`;
    statusEl.className = 'launch-game-status installed';
    currentVariant = firstInstalled;
  } else {
    statusEl.textContent = '未安装 — 点击管理安装游戏';
    statusEl.className = 'launch-game-status not-installed';
  }
}

/**
 * Main-screen card click: launch installed game directly, or open launcher if none installed.
 */
async function handlePlayFromCard(): Promise<void> {
  if (!state) state = await window.studioHub.launcherGetState();

  const variant = (['Shipping', 'Development', 'Testing'] as GameVariant[])
    .find((v) => state?.installed[v]);

  if (!variant) {
    showLauncherPage();
    return;
  }

  setStatus('warning', '正在启动游戏...');
  const result = await window.studioHub.launcherLaunch(variant);
  if (result.success) {
    toast('游戏已启动');
    setStatus('ok', '就绪');
  } else {
    toast(`启动失败: ${result.error}`);
    setStatus('error', '启动失败');
  }
}

async function showLauncherPage(): Promise<void> {
  document.getElementById('launcher-page')!.classList.remove('page-hidden');
  await refreshLauncherData();
}

function hideLauncherPage(): void {
  document.getElementById('launcher-page')!.classList.add('page-hidden');
}

async function refreshLauncherData(): Promise<void> {
  state = await window.studioHub.launcherGetState();

  const config = getConfigRef!();
  document.getElementById('launcher-install-dir-text')!.textContent =
    config.launcher?.installDir || '未设置';

  const connDot = document.getElementById('launcher-conn-dot')!;
  const connText = document.getElementById('launcher-conn-text')!;

  if (!config.minio?.endpoint || !config.launcher?.prefix) {
    connDot.className = 'status-dot idle';
    connText.textContent = !config.minio?.endpoint ? '服务器未配置' : '路径前缀未配置';
    manifest = null;
    showPanel('not-configured');
    return;
  }

  connDot.className = 'status-dot warning';
  connText.textContent = '连接中...';

  // Step 1: test S3 connection
  const connResult = await window.studioHub.launcherTestConnection();
  if (!connResult.success) {
    connDot.className = 'status-dot error';
    connText.textContent = '连接失败';
    manifest = null;
    showPanel('not-configured');
    document.getElementById('launcher-not-configured')!.innerHTML =
      `<p style="text-align:center;padding:40px 0;color:var(--danger);font-size:13px;">${connResult.error || '无法连接 MinIO 服务器'}</p>`;
    return;
  }

  // Step 2: discover builds
  const manifestResult = await window.studioHub.launcherGetManifest();
  manifest = manifestResult.data;

  if (manifestResult.error) {
    connDot.className = 'status-dot error';
    connText.textContent = '发现构建失败';
    showPanel('not-configured');
    document.getElementById('launcher-not-configured')!.innerHTML =
      `<p style="text-align:center;padding:40px 0;color:var(--danger);font-size:13px;">构建发现失败: ${manifestResult.error}</p>`;
    return;
  }

  if (manifest && manifest.builds.length > 0) {
    connDot.className = 'status-dot';
    connText.textContent = '已连接';
    renderVariant();
  } else {
    connDot.className = 'status-dot';
    connText.textContent = '已连接 · 无构建';
    showPanel('no-builds');
  }
}

function selectVariant(variant: GameVariant): void {
  currentVariant = variant;
  document.querySelectorAll('#launcher-tabs .launcher-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.getAttribute('data-variant') === variant);
  });
  renderVariant();
}

function getLatestBuild(variant: GameVariant): BuildInfo | null {
  if (!manifest) return null;
  const builds = manifest.builds.filter((b) => b.variant === variant);
  if (builds.length === 0) return null;
  builds.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    if (tb !== ta) return tb - ta;
    // Fall back to version string comparison when timestamps are equal
    return b.version.localeCompare(a.version, undefined, { numeric: true, sensitivity: 'base' });
  });
  return builds[0];
}

function getInstalledBuild(variant: GameVariant): InstalledBuild | undefined {
  return state?.installed[variant];
}

// --- Rendering ---

function showPanel(panel: 'not-configured' | 'no-builds' | 'details'): void {
  const ids = ['launcher-not-configured', 'launcher-no-builds', 'launcher-build-details'];
  const show =
    panel === 'not-configured' ? ids[0] : panel === 'no-builds' ? ids[1] : ids[2];
  ids.forEach((id) => {
    (document.getElementById(id) as HTMLElement).style.display = id === show ? '' : 'none';
  });
  if (panel !== 'details') hideAllActions();
}

function hideAllActions(): void {
  ['launcher-btn-install', 'launcher-btn-launch', 'launcher-btn-update', 'launcher-btn-uninstall']
    .forEach((id) => ((document.getElementById(id) as HTMLElement).style.display = 'none'));
}

function renderVariant(): void {
  const build = getLatestBuild(currentVariant);
  const installed = getInstalledBuild(currentVariant);

  if (!build) {
    showPanel('no-builds');
    return;
  }

  showPanel('details');

  document.getElementById('launcher-remote-version')!.textContent = build.version;
  document.getElementById('launcher-remote-build')!.textContent = build.buildNumber;
  document.getElementById('launcher-remote-size')!.textContent = build.size > 0 ? formatBytes(build.size) : '—';
  const ts = build.timestamp;
  document.getElementById('launcher-remote-time')!.textContent = ts && new Date(ts).getFullYear() > 1970 ? formatDate(ts) : '—';

  const notesEl = document.getElementById('launcher-remote-notes')!;
  if (build.notes) {
    notesEl.textContent = build.notes;
    notesEl.style.display = '';
  } else {
    notesEl.style.display = 'none';
  }

  const localInfoEl = document.getElementById('launcher-local-info')!;
  if (installed) {
    localInfoEl.style.display = '';
    document.getElementById('launcher-local-version')!.textContent =
      `${installed.version} (${installed.buildNumber})`;
    document.getElementById('launcher-local-time')!.textContent = formatDate(installed.installedAt);
    document.getElementById('launcher-local-size')!.textContent = formatBytes(installed.size);
  } else {
    localInfoEl.style.display = 'none';
  }

  if (isInstalling) {
    hideAllActions();
    return;
  }

  const btnInstall = document.getElementById('launcher-btn-install') as HTMLElement;
  const btnLaunch = document.getElementById('launcher-btn-launch') as HTMLElement;
  const btnUpdate = document.getElementById('launcher-btn-update') as HTMLElement;
  const btnUninstall = document.getElementById('launcher-btn-uninstall') as HTMLElement;

  if (!installed) {
    btnInstall.style.display = '';
    btnLaunch.style.display = 'none';
    btnUpdate.style.display = 'none';
    btnUninstall.style.display = 'none';
  } else {
    btnInstall.style.display = 'none';
    btnLaunch.style.display = '';
    btnUninstall.style.display = '';
    const hasUpdate =
      installed.version !== build.version || installed.buildNumber !== build.buildNumber;
    btnUpdate.style.display = hasUpdate ? '' : 'none';
  }
}

// --- Actions ---

async function handleInstall(): Promise<void> {
  if (isInstalling) return;

  const config = getConfigRef!();
  if (!config.launcher?.installDir) {
    toast('请先设置安装目录');
    return;
  }

  isInstalling = true;
  showProgressBar();
  hideAllActions();
  setStatus('warning', '正在安装游戏...');

  const result = await window.studioHub.launcherInstall(currentVariant);

  isInstalling = false;

  if (result.success) {
    toast(`${currentVariant} 版本安装完成`);
    setStatus('ok', '就绪');
  } else {
    toast(`安装失败: ${result.error}`);
    setStatus('error', '安装失败');
  }

  hideProgressBar();
  await refreshLauncherData();
  await refreshGameCardStatus();
}

async function handleLaunch(): Promise<void> {
  setStatus('warning', '正在启动游戏...');
  const result = await window.studioHub.launcherLaunch(currentVariant);
  if (result.success) {
    toast('游戏已启动');
    setStatus('ok', '就绪');
  } else {
    toast(`启动失败: ${result.error}`);
    setStatus('error', '启动失败');
  }
}

async function handleUninstall(): Promise<void> {
  const result = await window.studioHub.launcherUninstall(currentVariant);
  if (result.success) {
    toast(`${currentVariant} 已卸载`);
  } else {
    toast(`卸载失败: ${result.error}`);
  }
  await refreshLauncherData();
  await refreshGameCardStatus();
}

async function handleBrowseDir(): Promise<void> {
  const dir = await window.studioHub.launcherSelectInstallDir();
  if (!dir) return;

  document.getElementById('launcher-install-dir-text')!.textContent = dir;
  const config = getConfigRef!();
  const updated = {
    ...config,
    launcher: { ...config.launcher, installDir: dir },
  };
  await window.studioHub.saveConfig(updated);
  // Reflect the change back so subsequent getConfig() calls see it
  Object.assign(config, updated);
}

// --- Progress ---

function showProgressBar(): void {
  document.getElementById('launcher-progress')!.style.display = '';
  (document.getElementById('launcher-progress-fill') as HTMLElement).style.width = '0%';
  (document.getElementById('launcher-progress-fill') as HTMLElement).style.background = '';
  document.getElementById('launcher-progress-label')!.textContent = '准备中...';
  document.getElementById('launcher-progress-detail')!.textContent = '';
}

function hideProgressBar(): void {
  setTimeout(() => {
    document.getElementById('launcher-progress')!.style.display = 'none';
  }, 1500);
}

function handleProgress(progress: DownloadProgress): void {
  if (progress.variant !== currentVariant) return;

  const fill = document.getElementById('launcher-progress-fill') as HTMLElement;
  const label = document.getElementById('launcher-progress-label')!;
  const detail = document.getElementById('launcher-progress-detail')!;

  fill.style.width = progress.percent + '%';

  switch (progress.phase) {
    case 'downloading':
      label.textContent = `下载中... ${progress.percent}%`;
      if (progress.downloadedBytes != null && progress.totalBytes) {
        const speed = progress.speed ? formatBytes(Math.round(progress.speed)) + '/s' : '';
        detail.textContent =
          `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}  ${speed}`;
      }
      break;
    case 'extracting':
      label.textContent = progress.message || '解压中...';
      detail.textContent = '';
      break;
    case 'done':
      label.textContent = '安装完成';
      fill.style.background = 'var(--green)';
      detail.textContent = '';
      break;
    case 'error':
      label.textContent = '安装失败';
      fill.style.background = 'var(--danger)';
      detail.textContent = progress.message || '';
      break;
  }
}

// --- Helpers ---

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN');
  } catch {
    return iso;
  }
}

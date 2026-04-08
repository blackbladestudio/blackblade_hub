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

let currentVariant: GameVariant = 'Development';
let manifest: LauncherManifest | null = null;
let state: LauncherState | null = null;
let isInstalling = false;
let getConfigRef: (() => AppConfig) | null = null;
let runningVariants: Set<GameVariant> = new Set();
let pollInterval: ReturnType<typeof setInterval> | null = null;
let mainPollInterval: ReturnType<typeof setInterval> | null = null;

async function pollRunningStatus(): Promise<void> {
  const variants: GameVariant[] = ['Development', 'Testing', 'Shipping'];
  for (const v of variants) {
    const isRunning = await window.studioHub.launcherCheckRunning(v);
    if (isRunning) {
      runningVariants.add(v);
    } else {
      runningVariants.delete(v);
    }
  }
  updateLaunchButtonState();
}

function updateLaunchButtonState(): void {
  const isRunning = runningVariants.has(currentVariant);
  const btnLaunch = document.getElementById('launcher-btn-launch') as HTMLElement;
  if (isRunning) {
    btnLaunch.textContent = '⏹ 停止游戏';
    btnLaunch.classList.add('running');
  } else {
    btnLaunch.textContent = '▶ 启动游戏';
    btnLaunch.classList.remove('running');
  }
}

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
  document.getElementById('launcher-btn-open-dir')!.addEventListener('click', handleOpenDir);

  window.studioHub.onLauncherProgress(handleProgress);

  refreshGameCardStatus();
  mainPollInterval = setInterval(refreshGameCardStatus, 5000);
}

/**
 * Update the small status text on the main-screen game card.
 * Called on init and after every install/uninstall.
 */
export async function refreshGameCardStatus(): Promise<void> {
  state = await window.studioHub.launcherGetState();
  const cardEl = document.getElementById('launch-game-play')!;
  const iconEl = cardEl.querySelector('.launch-icon-wrap') as HTMLElement;
  const nameEl = cardEl.querySelector('.launch-name') as HTMLElement;
  const statusEl = document.getElementById('launch-game-status')!;

  const firstInstalled = (['Development', 'Testing', 'Shipping'] as GameVariant[])
    .find((v) => state?.installed[v]);

  if (firstInstalled && state?.installed[firstInstalled]) {
    const b = state.installed[firstInstalled]!;
    const isRunning = await window.studioHub.launcherCheckRunning(firstInstalled);
    cardEl.classList.toggle('running', isRunning);
    if (isRunning) {
      iconEl.textContent = '⏹';
      nameEl.textContent = '停止游戏';
      statusEl.textContent = `${firstInstalled} 运行中`;
      statusEl.className = 'launch-game-status installed';
    } else {
      iconEl.textContent = '▶';
      nameEl.textContent = '启动游戏';
      statusEl.textContent = `${firstInstalled} ${b.version} ${b.buildNumber}`;
      statusEl.className = 'launch-game-status installed';
    }
    currentVariant = firstInstalled;
  } else {
    cardEl.classList.remove('running');
    iconEl.textContent = '▶';
    nameEl.textContent = '启动游戏';
    statusEl.textContent = '未安装 — 点击管理安装游戏';
    statusEl.className = 'launch-game-status not-installed';
  }
}

/**
 * Main-screen card click: launch installed game directly, or open launcher if none installed.
 */
async function handlePlayFromCard(): Promise<void> {
  if (!state) state = await window.studioHub.launcherGetState();

  const variant = (['Development', 'Testing', 'Shipping'] as GameVariant[])
    .find((v) => state?.installed[v]);

  if (!variant) {
    showLauncherPage();
    return;
  }

  const isRunning = await window.studioHub.launcherCheckRunning(variant);
  if (isRunning) {
    const result = await window.studioHub.launcherStop(variant);
    if (result.success) toast('游戏已停止');
    await refreshGameCardStatus();
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
  await refreshGameCardStatus();
}

async function showLauncherPage(): Promise<void> {
  document.getElementById('launcher-page')!.classList.remove('page-hidden');
  await refreshLauncherData();
  await pollRunningStatus();
  pollInterval = setInterval(pollRunningStatus, 3000);
}

function hideLauncherPage(): void {
  document.getElementById('launcher-page')!.classList.add('page-hidden');
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
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
    renderVariant(currentVariant);
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
  refreshLauncherData();
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
  ['launcher-btn-install', 'launcher-btn-launch', 'launcher-btn-update', 'launcher-btn-uninstall', 'launcher-btn-open-dir']
    .forEach((id) => ((document.getElementById(id) as HTMLElement).style.display = 'none'));
}

function renderVariant(variant: GameVariant): void {
  const build = getLatestBuild(variant);
  const installed = getInstalledBuild(variant);

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
      `${installed.version} ${installed.buildNumber}`;
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
    btnUpdate.style.display = 'none';
    btnLaunch.style.display = 'none';
    btnUninstall.style.display = 'none';
    document.getElementById('launcher-btn-open-dir')!.style.display = 'none';
  } else {
    btnInstall.style.display = 'none';
    btnLaunch.style.display = '';
    btnUninstall.style.display = '';
    document.getElementById('launcher-btn-open-dir')!.style.display = '';
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
  await pollRunningStatus();
}

async function handleLaunch(): Promise<void> {
  const isRunning = runningVariants.has(currentVariant);
  if (isRunning) {
    const result = await window.studioHub.launcherStop(currentVariant);
    if (result.success) {
      toast('游戏已停止');
    } else {
      toast('停止游戏失败');
    }
    await pollRunningStatus();
    return;
  }
  setStatus('warning', '正在启动游戏...');
  const result = await window.studioHub.launcherLaunch(currentVariant);
  if (result.success) {
    toast('游戏已启动');
    setStatus('ok', '就绪');
    await pollRunningStatus();
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
  Object.assign(config, updated);
}

async function handleOpenDir(): Promise<void> {
  const result = await window.studioHub.launcherOpenInstallDir(currentVariant);
  if (!result.success) {
    toast('打开目录失败: ' + result.error);
  }
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
  const fill = document.getElementById('launcher-progress-fill') as HTMLElement;
  const label = document.getElementById('launcher-progress-label')!;
  const detail = document.getElementById('launcher-progress-detail')!;

  fill.style.width = progress.percent + '%';

  switch (progress.phase) {
    case 'downloading':
      label.textContent = `下载中... ${progress.percent}%`;
      if (progress.downloadedBytes != null) {
        const downloadedStr = formatBytes(progress.downloadedBytes);
        if (progress.totalBytes) {
          const speed = progress.speed ? formatBytes(Math.round(progress.speed)) + '/s' : '';
          detail.textContent = `${downloadedStr} / ${formatBytes(progress.totalBytes)}  ${speed}`;
        } else {
          detail.textContent = downloadedStr + ' 已下载';
        }
      } else {
        detail.textContent = progress.message || '下载中';
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

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
import { appendLog } from './log-panel';

let currentVariant: GameVariant = 'Development';
let manifest: LauncherManifest | null = null;
let state: LauncherState | null = null;
let isInstalling = false;
let getConfigRef: (() => AppConfig) | null = null;
let runningVariants: Set<GameVariant> = new Set();
let selectedBuildKeys: Partial<Record<GameVariant, string>> = {};
let defaultVariant: GameVariant | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let mainPollInterval: ReturnType<typeof setInterval> | null = null;

async function pollRunningStatus(): Promise<void> {
  const variants: GameVariant[] = ['Development', 'Test', 'Shipping'];
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
    const variant = tab.getAttribute('data-variant') as GameVariant;
    tab.addEventListener('click', () => {
      selectVariant(variant);
    });
    // 星标点击：切换默认包体，阻止冒泡以免触发 tab 切换
    const star = tab.querySelector('.launcher-tab-star');
    star?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDefaultVariant(variant);
    });
  });

  document.getElementById('launcher-btn-install')!.addEventListener('click', handleInstall);
  document.getElementById('launcher-btn-launch')!.addEventListener('click', handleLaunch);
  document.getElementById('launcher-btn-update')!.addEventListener('click', handleInstall);
  document.getElementById('launcher-btn-check-update')!.addEventListener('click', handleQuickCheckUpdate);
  document.getElementById('launcher-btn-verify-files')!.addEventListener('click', handleForceCheckUpdate);
  document.getElementById('launcher-btn-uninstall')!.addEventListener('click', handleUninstall);
  document.getElementById('launcher-btn-set-default')!.addEventListener('click', handleSetDefault);
  document.getElementById('launcher-btn-browse-dir')!.addEventListener('click', handleBrowseDir);
  document.getElementById('launcher-btn-open-dir')!.addEventListener('click', handleOpenDir);
  document.getElementById('launcher-btn-abort')!.addEventListener('click', handleAbortInstall);
  document.getElementById('launcher-btn-more')!.addEventListener('click', toggleDropdown);
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('launcher-more-wrap')!;
    if (!wrap.contains(e.target as Node)) closeDropdown();
  });
  document.getElementById('launcher-remote-build-select')!.addEventListener('change', (event) => {
    selectedBuildKeys[currentVariant] = (event.target as HTMLSelectElement).value;
    renderVariant(currentVariant);
  });

  window.studioHub.onLauncherProgress(handleProgress);
  window.studioHub.onLauncherUpdateAvailable(handleStartupUpdateAvailable);

  refreshGameCardStatus();
  mainPollInterval = setInterval(refreshGameCardStatus, 5000);
}

/**
 * 解析主界面「启动游戏」应使用的包体：
 * 优先使用已设置且仍安装的默认包体，否则回退到第一个已安装的包体。
 */
function resolveLaunchVariant(): GameVariant | null {
  if (defaultVariant && state?.installed[defaultVariant]) {
    return defaultVariant;
  }
  return (['Development', 'Test', 'Shipping'] as GameVariant[])
    .find((v) => state?.installed[v]) ?? null;
}

/**
 * Update the small status text on the main-screen game card.
 * Called on init and after every install/uninstall.
 */
export async function refreshGameCardStatus(): Promise<void> {
  state = await window.studioHub.launcherGetState();
  defaultVariant = state.defaultVariant ?? null;
  const cardEl = document.getElementById('launch-game-play')!;
  const iconEl = cardEl.querySelector('.launch-icon-wrap') as HTMLElement;
  const nameEl = cardEl.querySelector('.launch-name') as HTMLElement;
  const statusEl = document.getElementById('launch-game-status')!;

  const launchVariant = resolveLaunchVariant();

  if (launchVariant && state?.installed[launchVariant]) {
    const b = state.installed[launchVariant]!;
    const isRunning = await window.studioHub.launcherCheckRunning(launchVariant);
    cardEl.classList.toggle('running', isRunning);
    if (isRunning) {
      iconEl.textContent = '⏹';
      nameEl.textContent = '停止游戏';
      statusEl.textContent = `${launchVariant} 运行中`;
      statusEl.className = 'launch-game-status installed';
    } else {
      iconEl.textContent = '▶';
      nameEl.textContent = '启动游戏';
      statusEl.textContent = `${launchVariant} ${b.version} ${b.buildNumber}`;
      statusEl.className = 'launch-game-status installed';
    }
    // 注意：此处不写回 currentVariant。
    // launcher 页的当前选中包体只应由 tab 切换控制，
    // 否则在 Development 已安装、Test 未安装时，主界面 5s 轮询会把
    // currentVariant 偷偷改回 Development，导致在 Test tab 点安装却装到 Development 目录。
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
  if (!state) {
    state = await window.studioHub.launcherGetState();
    defaultVariant = state.defaultVariant ?? null;
  }

  const variant = resolveLaunchVariant();

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
  defaultVariant = state.defaultVariant ?? null;
  renderVariantTabs();

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

/** 渲染包体 tab 的默认星标：已安装才显示星标，默认包体为实心 ⭐，其余为空心 ☆ */
function renderVariantTabs(): void {
  document.querySelectorAll('#launcher-tabs .launcher-tab').forEach((tab) => {
    const variant = tab.getAttribute('data-variant') as GameVariant;
    const isDefault = variant === defaultVariant;
    const isInstalled = !!state?.installed[variant];
    tab.classList.toggle('is-default', isDefault);

    const star = tab.querySelector('.launcher-tab-star') as HTMLElement | null;
    if (star) {
      star.style.display = isInstalled ? '' : 'none';
      star.textContent = isDefault ? '⭐' : '☆';
      star.title = isDefault ? '取消默认启动' : '设为默认启动';
    }
  });
}

function getLatestBuild(variant: GameVariant): BuildInfo | null {
  if (!manifest) return null;
  const builds = manifest.builds.filter((b) => b.variant === variant);
  if (builds.length === 0) return null;
  builds.sort(compareBuilds);
  return builds[0];
}

function compareBuilds(a: BuildInfo, b: BuildInfo): number {
    const versionCompare = b.version.localeCompare(a.version, undefined, { numeric: true, sensitivity: 'base' });
    if (versionCompare !== 0) return versionCompare;
    const buildCompare = b.buildNumber.localeCompare(a.buildNumber, undefined, { numeric: true, sensitivity: 'base' });
    if (buildCompare !== 0) return buildCompare;
    const aLabel = a.objectKey.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
    const bLabel = b.objectKey.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
    const aHasVPrefix = /^v/i.test(aLabel);
    const bHasVPrefix = /^v/i.test(bLabel);
    if (aHasVPrefix !== bHasVPrefix) return bHasVPrefix ? 1 : -1;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
}

function getBuildsForVariant(variant: GameVariant): BuildInfo[] {
  if (!manifest) return [];
  return manifest.builds.filter((b) => b.variant === variant).sort(compareBuilds);
}

function getSelectedBuild(variant: GameVariant): BuildInfo | null {
  const builds = getBuildsForVariant(variant);
  if (builds.length === 0) return null;
  const selectedKey = selectedBuildKeys[variant];
  const selected = selectedKey ? builds.find((b) => b.objectKey === selectedKey) : null;
  if (selected) return selected;
  selectedBuildKeys[variant] = builds[0].objectKey;
  return builds[0];
}

function renderBuildSelector(variant: GameVariant): void {
  const select = document.getElementById('launcher-remote-build-select') as HTMLSelectElement;
  const builds = getBuildsForVariant(variant);
  select.innerHTML = '';
  for (const build of builds) {
    const option = document.createElement('option');
    option.value = build.objectKey;
    const label = build.objectKey.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? build.version;
    option.textContent = label;
    select.appendChild(option);
  }

  const selected = getSelectedBuild(variant);
  select.value = selected?.objectKey ?? '';
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
  (document.getElementById('launcher-btn-install') as HTMLElement).style.display = 'none';
  (document.getElementById('launcher-btn-launch') as HTMLElement).style.display = 'none';
  (document.getElementById('launcher-btn-update') as HTMLElement).style.display = 'none';
  (document.getElementById('launcher-more-wrap') as HTMLElement).style.display = 'none';
}

function renderVariant(variant: GameVariant): void {
  const build = getSelectedBuild(variant);
  const installed = getInstalledBuild(variant);

  if (!build) {
    showPanel('no-builds');
    return;
  }

  showPanel('details');
  renderBuildSelector(variant);

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
  const btnSetDefault = document.getElementById('launcher-btn-set-default') as HTMLElement;

  if (!installed) {
    btnInstall.style.display = '';
    btnLaunch.style.display = 'none';
    (document.getElementById('launcher-btn-update') as HTMLElement).style.display = 'none';
    (document.getElementById('launcher-more-wrap') as HTMLElement).style.display = 'none';
  } else {
    btnInstall.style.display = 'none';
    btnLaunch.style.display = '';
    (document.getElementById('launcher-btn-update') as HTMLElement).style.display = 'none';
    (document.getElementById('launcher-more-wrap') as HTMLElement).style.display = '';

    // 「设为/取消默认启动」：已是默认时高亮并提供取消入口
    const isDefault = defaultVariant === variant;
    btnSetDefault.classList.toggle('highlight', isDefault);
    btnSetDefault.textContent = isDefault ? '✓ 取消默认启动' : '⭐ 设为默认启动';
  }
}

async function checkVersionUpdate(
  variant: GameVariant,
  installed: InstalledBuild,
  build: BuildInfo,
): Promise<void> {
  const btnUpdate = document.getElementById('launcher-btn-update') as HTMLElement;

  const dirHasUpdate = installed.version !== build.version || installed.buildNumber !== build.buildNumber;
  if (dirHasUpdate) {
    btnUpdate.style.display = '';
    return;
  }

  try {
    const result = await window.studioHub.launcherCheckUpdates(variant, build.objectKey);
    if (result.hasUpdate) {
      btnUpdate.style.display = '';
      const localInfoEl = document.getElementById('launcher-local-info')!;
      const versionEl = document.getElementById('launcher-local-version')!;
      if (result.localVersion && result.remoteVersion) {
        versionEl.textContent = `${installed.version} ${installed.buildNumber} → ${result.remoteVersion}`;
        localInfoEl.classList.add('has-update');
      }
    } else {
      btnUpdate.style.display = 'none';
    }
  } catch {
    const dirFallback = installed.version !== build.version || installed.buildNumber !== build.buildNumber;
    btnUpdate.style.display = dirFallback ? '' : 'none';
  }
}

// --- Actions ---

async function handleInstall(): Promise<void> {
  if (isInstalling) return;
  closeDropdown();

  const config = getConfigRef!();
  if (!config.launcher?.installDir) {
    toast('请先设置安装目录');
    return;
  }

  isInstalling = true;
  showProgressBar();
  appendLog('info', `[launcher] 开始下载 ${currentVariant} 版本`);
  hideAllActions();
  setStatus('warning', '正在安装游戏...');

  const selectedBuild = getSelectedBuild(currentVariant);
  const result = await window.studioHub.launcherInstall(currentVariant, selectedBuild?.objectKey);

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

/**
 * 快速检查：只比对远端与本地的 version.txt，不列举文件。
 * 日常「有没有新版本」用这个，秒级返回。
 */
async function handleQuickCheckUpdate(): Promise<void> {
  const btnCheck = document.getElementById('launcher-btn-check-update') as HTMLElement;
  const origText = btnCheck.textContent;
  btnCheck.textContent = '检测中...';
  btnCheck.setAttribute('disabled', 'true');

  try {
    const selectedBuild = getSelectedBuild(currentVariant);
    const result = await window.studioHub.launcherCheckUpdates(currentVariant, selectedBuild?.objectKey);
    if (result.error) {
      toast(`检测失败: ${result.error}`);
      return;
    }

    const btnUpdate = document.getElementById('launcher-btn-update') as HTMLElement;
    if (result.hasUpdate) {
      btnUpdate.style.display = '';
      const from = result.localVersion || '无';
      toast(result.remoteVersion ? `发现新版本: ${from} → ${result.remoteVersion}` : '发现可用更新');
    } else {
      btnUpdate.style.display = 'none';
      toast('已是最新版本');
    }
  } catch (err) {
    toast(`检测更新失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btnCheck.textContent = origText;
    btnCheck.removeAttribute('disabled');
    closeDropdown();
  }
}

/**
 * 全量校验：列举远端所有对象并逐个比对本地文件大小。
 * 能发现文件损坏或缺失，但在几万文件的包体上耗时明显。
 */
async function handleForceCheckUpdate(): Promise<void> {
  const btnCheck = document.getElementById('launcher-btn-verify-files') as HTMLElement;
  const origText = btnCheck.textContent;
  btnCheck.textContent = '校验中...';
  btnCheck.setAttribute('disabled', 'true');

  try {
    const selectedBuild = getSelectedBuild(currentVariant);
    const result = await window.studioHub.launcherForceCheckUpdates(currentVariant, selectedBuild?.objectKey);
    if (result.error || !result.data) {
      toast(`校验失败: ${result.error || '未知错误'}`);
      return;
    }

    const current = result.data.find((r) => r.variant === currentVariant);
    if (!current) {
      toast('未找到当前变体的构建信息');
      return;
    }

    appendLog(
      'info',
      `[launcher] 文件校验结果 ${current.variant}: 远端 ${current.remoteFileCount}，本地 ${current.localFileCount}，缺失 ${current.missingFiles}，大小不一致 ${current.sizeMismatchFiles}`,
    );

    if (current.needsSync) {
      const btnUpdate = document.getElementById('launcher-btn-update') as HTMLElement;
      btnUpdate.style.display = '';
      const reasons: string[] = [];
      if (current.missingFiles > 0) reasons.push(`缺少 ${current.missingFiles} 个文件`);
      if (current.sizeMismatchFiles > 0) reasons.push(`${current.sizeMismatchFiles} 个文件大小不一致`);
      if (current.remoteVersion && current.localVersion !== current.remoteVersion) {
        reasons.push(`版本 ${current.localVersion ?? '无'} → ${current.remoteVersion}`);
      }
      const diffCount = current.missingFiles + current.sizeMismatchFiles;
      toast(`校验发现 ${diffCount} 个差异${reasons.length > 0 ? '，' + reasons.join('，') : ''}`);
    } else {
      const btnUpdate = document.getElementById('launcher-btn-update') as HTMLElement;
      btnUpdate.style.display = 'none';
      toast('所有文件校验通过，无需更新');
    }
  } catch (err) {
    toast(`校验失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btnCheck.textContent = origText;
    btnCheck.removeAttribute('disabled');
    closeDropdown();
  }
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
  closeDropdown();
  const result = await window.studioHub.launcherUninstall(currentVariant);
  if (result.success) {
    toast(`${currentVariant} 已卸载`);
  } else {
    toast(`卸载失败: ${result.error}`);
  }
  await refreshLauncherData();
  await refreshGameCardStatus();
}

async function handleSetDefault(): Promise<void> {
  closeDropdown();
  await toggleDefaultVariant(currentVariant);
}

/**
 * 切换默认启动包体：
 * - 若该包体已是默认，则取消默认（清除设置）
 * - 否则设为默认（要求已安装）
 */
async function toggleDefaultVariant(variant: GameVariant): Promise<void> {
  if (!getInstalledBuild(variant)) {
    toast('请先安装该包体');
    return;
  }

  const makeDefault = defaultVariant !== variant;
  const result = await window.studioHub.launcherSetDefaultVariant(makeDefault ? variant : null);
  if (result.success) {
    defaultVariant = makeDefault ? variant : null;
    toast(makeDefault ? `已将 ${variant} 设为默认启动包体` : `已取消 ${variant} 的默认启动`);
    renderVariantTabs();
    renderVariant(currentVariant);
    await refreshGameCardStatus();
  } else {
    toast(`设置失败: ${result.error}`);
  }
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
  closeDropdown();
  const result = await window.studioHub.launcherOpenInstallDir(currentVariant);
  if (!result.success) {
    toast('打开目录失败: ' + result.error);
  }
}

async function handleAbortInstall(): Promise<void> {
  if (!isInstalling) return;
  const result = await window.studioHub.launcherAbortInstall();
  if (result.success) {
    toast('下载已中断');
  }
}

// --- Dropdown Menu ---

function toggleDropdown(): void {
  const dropdown = document.getElementById('launcher-dropdown')!;
  dropdown.classList.toggle('open');
}

function closeDropdown(): void {
  const dropdown = document.getElementById('launcher-dropdown')!;
  dropdown.classList.remove('open');
}

// --- Progress ---

function showProgressBar(): void {
  document.getElementById('launcher-progress')!.style.display = '';
  (document.getElementById('launcher-progress-fill') as HTMLElement).style.width = '0%';
  (document.getElementById('launcher-progress-fill') as HTMLElement).style.background = '';
  (document.getElementById('launcher-progress-percent') as HTMLElement).textContent = '0%';
  document.getElementById('launcher-progress-label')!.textContent = '准备中...';
  document.getElementById('launcher-progress-detail')!.textContent = '';
  (document.getElementById('launcher-btn-abort') as HTMLElement).style.display = '';
}

function hideProgressBar(): void {
  setTimeout(() => {
    document.getElementById('launcher-progress')!.style.display = 'none';
  }, 1500);
}

function handleProgress(progress: DownloadProgress): void {
  const fill = document.getElementById('launcher-progress-fill') as HTMLElement;
  const percentEl = document.getElementById('launcher-progress-percent')!;
  const label = document.getElementById('launcher-progress-label')!;
  const detail = document.getElementById('launcher-progress-detail')!;

  if (progress.percent >= 0) {
    fill.style.width = progress.percent + '%';
    fill.classList.remove('indeterminate');
    percentEl.textContent = progress.percent + '%';
  } else {
    fill.classList.add('indeterminate');
    percentEl.textContent = '同步中';
  }

  switch (progress.phase) {
    case 'downloading':
      if (progress.percent >= 0) {
        label.textContent = progress.percent >= 100 ? '同步完成' : '正在同步游戏文件';
      } else {
        label.textContent = '正在同步游戏文件';
      }
      if (progress.downloadedBytes != null && progress.totalBytes) {
        const downloadedStr = formatBytes(progress.downloadedBytes);
        const speedText = progress.speed ? formatBytes(Math.round(progress.speed)) + '/s' : '计算中';
        const remaining = Math.max(0, progress.totalBytes - progress.downloadedBytes);
        const fileText = progress.totalFiles
          ? ` · ${progress.downloadedFiles ?? 0} / ${progress.totalFiles} 文件`
          : '';
        detail.textContent = `${downloadedStr} / ${formatBytes(progress.totalBytes)} · 剩余 ${formatBytes(remaining)} · ${speedText}${fileText}`;
      } else if (progress.downloadedBytes && progress.downloadedBytes > 0) {
        const downloadedStr = formatBytes(progress.downloadedBytes);
        const speedText = progress.speed ? formatBytes(Math.round(progress.speed)) + '/s' : '计算中';
        const fileText = progress.downloadedFiles ? ` · ${progress.downloadedFiles} 文件` : '';
        detail.textContent = `${downloadedStr} 已下载 · ${speedText}${fileText}`;
      } else {
        detail.textContent = progress.message || '准备中...';
      }
      break;
    case 'extracting':
      label.textContent = progress.message || '解压中...';
      detail.textContent = '';
      break;
    case 'verifying':
      label.textContent = progress.message || '正在校验文件...';
      detail.textContent = '';
      (document.getElementById('launcher-btn-abort') as HTMLElement).style.display = 'none';
      break;
    case 'done':
      label.textContent = '安装完成';
      fill.style.background = 'var(--green)';
      percentEl.textContent = '100%';
      detail.textContent = '';
      (document.getElementById('launcher-btn-abort') as HTMLElement).style.display = 'none';
      break;
    case 'error':
      label.textContent = '安装失败';
      fill.style.background = 'var(--danger)';
      percentEl.textContent = '失败';
      detail.textContent = progress.message || '';
      (document.getElementById('launcher-btn-abort') as HTMLElement).style.display = 'none';
      break;
  }
}

// --- Helpers ---

function handleStartupUpdateAvailable(
  updates: Array<{ variant: GameVariant; localVersion: string | null; remoteVersion: string | null }>,
): void {
  const banner = document.getElementById('update-banner')!;
  const bannerText = document.getElementById('update-banner-text')!;
  const labels = updates.map(
    (u) => `${u.variant}: ${u.localVersion ?? '未安装'} → ${u.remoteVersion}`,
  );
  bannerText.textContent = `游戏有更新可用 — ${labels.join('  |  ')}`;
  banner.style.display = 'flex';
  banner.onclick = () => {
    banner.style.display = 'none';
    showLauncherPage();
  };
  refreshGameCardStatus();
}

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

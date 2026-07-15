import { toast, setStatus } from '../utils';
import { showLogPanel, setLogHook } from './log-panel';

let cliOutputCallback: ((type: string, msg: string) => void) | null = null;
let isCliReady = false;
let isAssetHiveInstalling = false;

export function initToolbox(): void {
  document.getElementById('card-horde-agent')!.addEventListener('click', showHordeAgentPage);
  document.getElementById('card-unreal-toolbox')!.addEventListener('click', installUnrealToolbox);
  document.getElementById('card-setup-env-vars')!.addEventListener('click', setupEnvVars);
  document.getElementById('card-bb-cli')!.addEventListener('click', handleBbCliClick);
  document.getElementById('card-cc-switch')!.addEventListener('click', installCcSwitch);
  document.getElementById('card-assethive')!.addEventListener('click', handleAssetHiveClick);

  document.getElementById('ha-page-btn-install')!.addEventListener('click', haInstall);
  document.getElementById('ha-page-btn-start')!.addEventListener('click', haStart);
  document.getElementById('ha-page-btn-stop')!.addEventListener('click', haStop);

  document.querySelector('#horde-page .page-back')!.addEventListener('click', hideHordeAgentPage);
  document.getElementById('cli-back')!.addEventListener('click', hideCliPage);

  const cliInput = document.getElementById('cli-input') as HTMLInputElement;
  cliInput.addEventListener('keydown', handleCliInputKeydown);

  window.studioHub.onBbCliOutput((msg) => {
    if (cliOutputCallback) {
      cliOutputCallback(msg.type, msg.msg);
    }
    appendCliLine(msg.type, msg.msg);
  });

  void refreshAssetHiveStatus();
}

export async function refreshAssetHiveStatus(): Promise<void> {
  const dot = document.getElementById('dot-assethive');
  const description = document.getElementById('desc-assethive');
  if (!dot || !description || isAssetHiveInstalling) return;

  const [status, release] = await Promise.all([
    window.studioHub.getAssetHiveStatus(),
    window.studioHub.getAssetHiveRelease(),
  ]);

  if (status.state === 'ready') {
    dot.className = release.updateAvailable
      ? 'pipeline-status-dot warning'
      : 'pipeline-status-dot ready';
    if (release.updateAvailable) {
      description.textContent = `已安装 v${status.version} · 可升级 v${release.version}`;
    } else if (!release.available) {
      description.textContent = `已安装 v${status.version} · 更新状态不可用`;
    } else {
      description.textContent = `已安装 v${status.version} · 点击启动`;
    }
    return;
  }

  if (status.state === 'damaged') {
    dot.className = 'pipeline-status-dot error';
    description.textContent = '安装损坏 · 点击修复';
    return;
  }

  dot.className = release.available ? 'pipeline-status-dot warning' : 'pipeline-status-dot';
  description.textContent = release.available
    ? `未安装 · 最新 v${release.version}`
    : '未安装 · 暂时无法获取版本';
}

async function handleAssetHiveClick(): Promise<void> {
  if (isAssetHiveInstalling) return;
  const [status, release] = await Promise.all([
    window.studioHub.getAssetHiveStatus(),
    window.studioHub.getAssetHiveRelease(),
  ]);

  if (status.state === 'ready' && !release.updateAvailable) {
    const result = await window.studioHub.launchAssetHive();
    if (result.success) {
      toast('AssetHive 已启动');
      setStatus('ok', '就绪');
    } else {
      toast(`启动失败: ${result.error || '安装路径无效'}`);
      setStatus('error', '启动失败');
      await refreshAssetHiveStatus();
    }
    return;
  }

  if (
    status.state === 'ready'
    && release.updateAvailable
    && !window.confirm(`检测到 AssetHive ${release.version}，是否升级？`)
  ) {
    const result = await window.studioHub.launchAssetHive();
    if (!result.success) toast(`启动失败: ${result.error || '未知错误'}`);
    return;
  }

  await installAssetHive(status.state === 'ready');
}

async function installAssetHive(isUpgrade: boolean): Promise<void> {
  const card = document.getElementById('card-assethive');
  const dot = document.getElementById('dot-assethive');
  const progress = document.getElementById('progress-assethive');
  const fill = document.getElementById('progress-fill-assethive') as HTMLElement | null;
  const label = document.getElementById('progress-label-assethive');
  const description = document.getElementById('desc-assethive');

  const setProgress = (percent: number, text: string): void => {
    if (fill) fill.style.width = `${percent}%`;
    if (label) label.textContent = text;
  };

  isAssetHiveInstalling = true;
  card?.classList.add('installing');
  progress?.classList.add('visible');
  if (dot) dot.className = 'pipeline-status-dot warning';
  if (description) description.textContent = isUpgrade ? '正在升级...' : '正在安装...';
  if (fill) fill.style.background = '';
  setProgress(5, '查询最新版本...');
  setStatus('warning', isUpgrade ? '正在升级 AssetHive...' : '正在安装 AssetHive...');
  showLogPanel();

  setLogHook((_type, message) => {
    if (message.includes('release:')) setProgress(10, '查询最新版本...');
    else if (message.includes('download: checksum')) setProgress(20, '下载校验文件...');
    else if (message.includes('download: installer')) setProgress(35, '下载安装包...');
    else if (message.includes('verified:')) setProgress(70, '完整性验证通过');
    else if (message.includes('install:')) setProgress(80, isUpgrade ? '正在升级...' : '正在安装...');
    else if (message.includes('restart-required:')) setProgress(100, '安装完成 · 需要重启');
    else if (message.includes('success:')) setProgress(100, '安装完成 ✓');
  });

  const result = await window.studioHub.installAssetHive();
  setLogHook(null);

  if (result.success) {
    const verified = await window.studioHub.getAssetHiveStatus();
    if (verified.state === 'ready') {
      setProgress(100, '安装完成 ✓');
      if (fill) fill.style.background = 'var(--green)';
      if (dot) dot.className = 'pipeline-status-dot ready';
      toast(isUpgrade ? 'AssetHive 升级完成' : 'AssetHive 安装完成');
      setStatus('ok', '就绪');
    } else {
      setProgress(100, '安装后验证失败');
      if (fill) fill.style.background = 'var(--danger)';
      if (dot) dot.className = 'pipeline-status-dot error';
      toast('安装完成，但未检测到有效的 AssetHive 安装');
      setStatus('error', '安装验证失败');
    }
  } else {
    setProgress(100, '安装失败 · 点击重试');
    if (fill) fill.style.background = 'var(--danger)';
    if (dot) dot.className = 'pipeline-status-dot error';
    toast(`AssetHive 安装失败: ${result.error || `退出码 ${result.exitCode ?? '未知'}`}`);
    setStatus('error', '安装失败');
  }

  isAssetHiveInstalling = false;
  setTimeout(() => {
    progress?.classList.remove('visible');
    card?.classList.remove('installing');
    if (fill) fill.style.background = '';
    void refreshAssetHiveStatus();
  }, result.success ? 2000 : 3500);
}

async function handleBbCliClick(): Promise<void> {
  const status = await window.studioHub.getBbCliStatus();

  if (!status.isInstalled) {
    await installBbCli();
    const newStatus = await window.studioHub.getBbCliStatus();
    if (newStatus.isInstalled) {
      showCliPage();
    }
  } else {
    showCliPage();
  }
}

export async function refreshHordeAgentStatus(): Promise<void> {
  const status = await window.studioHub.getHordeAgentStatus();

  const dotHa = document.getElementById('dot-horde-agent')!;
  const bigStatusEl = document.getElementById('ha-big-status')!;
  const serverEl = document.getElementById('ha-detail-server')!;
  const workdirEl = document.getElementById('ha-detail-workdir')!;
  const pidEl = document.getElementById('ha-detail-pid')!;
  const btnInstall = document.getElementById('ha-page-btn-install') as HTMLElement;
  const btnStart = document.getElementById('ha-page-btn-start') as HTMLElement;
  const btnStop = document.getElementById('ha-page-btn-stop') as HTMLElement;

  serverEl.textContent = status.config.serverUrl || '-';
  workdirEl.textContent = status.workDir || '-';
  pidEl.textContent = status.pid?.toString() || '-';

  if (!status.isInstalled) {
    bigStatusEl.textContent = '未安装';
    bigStatusEl.className = 'ha-big-status warning';
    dotHa.className = 'pipeline-status-dot warning';
    btnInstall.style.display = 'inline-block';
    btnStart.style.display = 'none';
    btnStop.style.display = 'none';
  } else if (status.isRunning) {
    bigStatusEl.textContent = '运行中';
    bigStatusEl.className = 'ha-big-status running';
    dotHa.className = 'pipeline-status-dot ready';
    btnInstall.style.display = 'none';
    btnStart.style.display = 'none';
    btnStop.style.display = 'inline-block';
  } else {
    bigStatusEl.textContent = '已安装';
    bigStatusEl.className = 'ha-big-status installed';
    dotHa.className = 'pipeline-status-dot';
    btnInstall.style.display = 'none';
    btnStart.style.display = 'inline-block';
    btnStop.style.display = 'none';
  }
}

function showHordeAgentPage(): void {
  document.getElementById('horde-page')!.classList.remove('page-hidden');
  refreshHordeAgentStatus();
}

function hideHordeAgentPage(): void {
  document.getElementById('horde-page')!.classList.add('page-hidden');
}

async function haInstall(): Promise<void> {
  setStatus('warning', '正在安装HordeAgent...');
  showLogPanel();
  const result = await window.studioHub.runScript('tools/install_horde_agent.ps1');
  if (result.success) {
    toast('HordeAgent安装完成');
    setStatus('ok', '就绪');
    await refreshHordeAgentStatus();
  } else {
    toast(`安装失败: ${result.error}`);
    setStatus('error', '安装失败');
  }
}

async function haStart(): Promise<void> {
  setStatus('warning', '正在启动HordeAgent...');
  const result = await window.studioHub.startHordeAgent();
  if (result.success) {
    toast('HordeAgent已启动');
    setStatus('ok', '就绪');
    await refreshHordeAgentStatus();
  } else {
    toast(`启动失败: ${result.error}`);
    setStatus('error', '启动失败');
  }
}

async function haStop(): Promise<void> {
  setStatus('warning', '正在停止HordeAgent...');
  const result = await window.studioHub.stopHordeAgent();
  if (result.success) {
    toast('HordeAgent已停止');
    setStatus('ok', '就绪');
    await refreshHordeAgentStatus();
  } else {
    toast(`停止失败: ${result.error}`);
    setStatus('error', '停止失败');
  }
}

async function setupEnvVars(): Promise<void> {
  setStatus('warning', '正在设置环境变量...');
  showLogPanel();
  const result = await window.studioHub.runScript('tools/setup_p4_env.ps1');
  if (result.success) {
    toast('环境变量设置完成');
    setStatus('ok', '就绪');
  } else {
    toast(`设置失败: ${result.error || '请查看日志'}`);
    setStatus('error', '设置失败');
  }
}

async function installUnrealToolbox(): Promise<void> {
  const card = document.getElementById('card-unreal-toolbox');
  const dot = document.getElementById('dot-unreal-toolbox');
  const progress = document.getElementById('progress-unreal-toolbox');
  const fill = document.getElementById('progress-fill-unreal-toolbox') as HTMLElement | null;
  const label = document.getElementById('progress-label-unreal-toolbox');

  card?.classList.add('installing');
  if (dot) dot.className = 'pipeline-status-dot warning';
  progress?.classList.add('visible');

  function setProgress(pct: number, text: string): void {
    if (fill) fill.style.width = pct + '%';
    if (label) label.textContent = text;
  }

  setProgress(5, '准备中...');
  setStatus('warning', '正在安装 Unreal Toolbox...');

  setLogHook((_type, msg) => {
    if (msg.includes('1/3')) setProgress(15, '准备目录...');
    else if (msg.includes('2/3')) setProgress(30, '下载中...');
    else if (msg.includes('Download completed')) setProgress(65, '下载完成');
    else if (msg.includes('3/3')) setProgress(75, '安装中...');
    else if (msg.includes('installed successfully') || msg.includes('Done!'))
      setProgress(100, '安装完成 ✓');
  });

  const result = await window.studioHub.runScript('tools/install_unreal_toolbox.ps1');
  setLogHook(null);

  if (result.success) {
    setProgress(100, '安装完成 ✓');
    if (fill) fill.style.background = 'var(--green)';
    if (dot) dot.className = 'pipeline-status-dot ready';
    toast('Unreal Toolbox 安装完成');
    setStatus('ok', '就绪');
    setTimeout(() => {
      progress?.classList.remove('visible');
      card?.classList.remove('installing');
    }, 2000);
  } else {
    setProgress(100, '安装失败');
    if (fill) fill.style.background = 'var(--danger)';
    if (dot) dot.className = 'pipeline-status-dot error';
    toast(`安装失败: ${result.error}`);
    setStatus('error', '安装失败');
    setTimeout(() => {
      progress?.classList.remove('visible');
      card?.classList.remove('installing');
      if (fill) fill.style.background = '';
    }, 3000);
  }
}

async function installCcSwitch(): Promise<void> {
  const card = document.getElementById('card-cc-switch');
  const dot = document.getElementById('dot-cc-switch');
  const progress = document.getElementById('progress-cc-switch');
  const fill = document.getElementById('progress-fill-cc-switch') as HTMLElement | null;
  const label = document.getElementById('progress-label-cc-switch');

  card?.classList.add('installing');
  if (dot) dot.className = 'pipeline-status-dot warning';
  progress?.classList.add('visible');

  function setProgress(pct: number, text: string): void {
    if (fill) fill.style.width = pct + '%';
    if (label) label.textContent = text;
  }

  setProgress(5, '准备中...');
  setStatus('warning', '正在安装 CC-Switch...');

  setLogHook((_type, msg) => {
    if (msg.includes('1/3')) setProgress(15, '查询最新版本...');
    else if (msg.includes('2/3')) setProgress(30, '下载中...');
    else if (msg.includes('Download completed')) setProgress(65, '下载完成');
    else if (msg.includes('3/3')) setProgress(75, '安装中...');
    else if (msg.includes('installed successfully') || msg.includes('Done!'))
      setProgress(100, '安装完成 ✓');
  });

  const result = await window.studioHub.runScript('tools/install_cc_switch.ps1');
  setLogHook(null);

  if (result.success) {
    setProgress(100, '安装完成 ✓');
    if (fill) fill.style.background = 'var(--green)';
    if (dot) dot.className = 'pipeline-status-dot ready';
    toast('CC-Switch 安装完成');
    setStatus('ok', '就绪');
    setTimeout(() => {
      progress?.classList.remove('visible');
      card?.classList.remove('installing');
    }, 2000);
  } else {
    setProgress(100, '安装失败');
    if (fill) fill.style.background = 'var(--danger)';
    if (dot) dot.className = 'pipeline-status-dot error';
    toast(`安装失败: ${result.error}`);
    setStatus('error', '安装失败');
    setTimeout(() => {
      progress?.classList.remove('visible');
      card?.classList.remove('installing');
      if (fill) fill.style.background = '';
    }, 3000);
  }
}

async function installBbCli(): Promise<void> {
  const card = document.getElementById('card-bb-cli');
  const dot = document.getElementById('dot-bb-cli');
  const progress = document.getElementById('progress-bb-cli');
  const fill = document.getElementById('progress-fill-bb-cli') as HTMLElement | null;
  const label = document.getElementById('progress-label-bb-cli');

  card?.classList.add('installing');
  if (dot) dot.className = 'pipeline-status-dot warning';
  progress?.classList.add('visible');

  function setProgress(pct: number, text: string): void {
    if (fill) fill.style.width = pct + '%';
    if (label) label.textContent = text;
  }

  setProgress(10, '正在安装 bb CLI...');
  setStatus('warning', '正在安装 BlackBlade CLI...');

  setLogHook((_type, msg) => {
    if (msg.includes('Checking source')) setProgress(20, '检查源文件...');
    else if (msg.includes('Installing to')) setProgress(40, '复制文件...');
    else if (msg.includes('Adding to user PATH')) setProgress(60, '配置 PATH...');
    else if (msg.includes('Verifying')) setProgress(80, '验证安装...');
    else if (msg.includes('installed successfully')) setProgress(100, '安装完成 ✓');
  });

  const result = await window.studioHub.runScript('tools/install_bb_cli.ps1');
  setLogHook(null);

  if (result.success) {
    setProgress(100, '安装完成 ✓');
    if (fill) fill.style.background = 'var(--green)';
    if (dot) dot.className = 'pipeline-status-dot ready';
    toast('BlackBlade CLI 安装完成');
    setStatus('ok', '就绪');
    setTimeout(() => {
      progress?.classList.remove('visible');
      card?.classList.remove('installing');
    }, 2000);
  } else {
    setProgress(100, '安装失败');
    if (fill) fill.style.background = 'var(--danger)';
    if (dot) dot.className = 'pipeline-status-dot error';
    toast(`安装失败: ${result.error}`);
    setStatus('error', '安装失败');
    setTimeout(() => {
      progress?.classList.remove('visible');
      card?.classList.remove('installing');
      if (fill) fill.style.background = '';
    }, 3000);
  }
}

function showCliPage(): void {
  document.getElementById('cli-page')!.classList.remove('page-hidden');
  initCliTerminal();
}

function hideCliPage(): void {
  document.getElementById('cli-page')!.classList.add('page-hidden');
}

function initCliTerminal(): void {
  const output = document.getElementById('cli-output')!;
  const badge = document.getElementById('cli-status-badge')!;
  const input = document.getElementById('cli-input') as HTMLInputElement;

  output.innerHTML = '';
  badge.textContent = '就绪';
  badge.className = 'cli-terminal-badge ready';
  input.value = '';
  input.focus();

  appendCliLine('welcome', 'BlackBlade CLI Terminal');
  appendCliLine('info', 'Type "bb --help" to see available commands');
  appendCliLine('info', '');
  isCliReady = true;
}

function appendCliLine(type: string, msg: string): void {
  const output = document.getElementById('cli-output');
  if (!output) return;

  const line = document.createElement('pre');
  line.className = `cli-line ${type}`;
  line.textContent = msg;
  output.appendChild(line);
  output.scrollTop = output.scrollHeight;
}

async function handleCliInputKeydown(e: KeyboardEvent): Promise<void> {
  if (e.key !== 'Enter') return;

  const input = e.target as HTMLInputElement;
  const cmd = input.value.trim();

  if (!cmd) return;

  input.value = '';

  if (cmd === 'clear') {
    const output = document.getElementById('cli-output')!;
    output.innerHTML = '';
    appendCliLine('welcome', 'BlackBlade CLI Terminal');
    appendCliLine('info', 'Type "bb --help" to see available commands');
    appendCliLine('info', '');
    return;
  }

  appendCliLine('cmd', `❯ ${cmd}`);

  const args = cmd.split(' ').filter(a => a.length > 0);
  const result = await window.studioHub.runBbCliCommand(args);

  if (!result.success) {
    appendCliLine('error', result.error || 'Command failed');
  }
}
import type { AppConfig } from '../../types/config';
import { toast, setStatus } from '../utils';
import { showLogPanel } from './log-panel';

let isInstallingUgs = false;

export function initPipeline(getConfig: () => AppConfig): void {
  document.getElementById('card-ugs')!.addEventListener('click', () =>
    handleUgsClick(),
  );
  document.getElementById('card-jenkins')!.addEventListener('click', () =>
    handlePipeline('jenkins', getConfig()),
  );
  document.getElementById('card-horde')!.addEventListener('click', () =>
    handlePipeline('horde', getConfig()),
  );
  document.getElementById('card-env')!.addEventListener('click', () =>
    handlePipeline('env', getConfig()),
  );
}

export async function refreshUgsStatus(): Promise<void> {
  const card = document.getElementById('card-ugs');
  const dot = document.getElementById('dot-ugs');
  const nameEl = document.getElementById('ugs-name');
  const descEl = document.getElementById('ugs-desc');

  const result = await window.studioHub.ugsCheckInstalled();
  console.log('[UGS] refreshUgsStatus - installed?', result.installed, 'path:', result.path);

  if (card) {
    card.classList.toggle('disabled', !result.installed);
  }
  if (dot) {
    dot.className = result.installed ? 'pipeline-status-dot ready' : 'pipeline-status-dot';
  }
  if (nameEl) nameEl.textContent = 'UGS';
  if (descEl) descEl.textContent = '版本控制 / Perforce';
}

function setUgsInstalling(installing: boolean): void {
  const card = document.getElementById('card-ugs');
  const nameEl = document.getElementById('ugs-name');
  const descEl = document.getElementById('ugs-desc');
  const dot = document.getElementById('dot-ugs');

  if (card) {
    if (installing) {
      card.classList.remove('disabled');
      card.classList.add('installing');
    } else {
      card.classList.remove('installing');
    }
  }
  if (nameEl) nameEl.textContent = installing ? 'UGS' : 'UGS';
  if (descEl) descEl.textContent = installing ? '正在安装...' : '版本控制 / Perforce';
  if (dot) {
    dot.className = installing ? 'pipeline-status-dot warning' : 'pipeline-status-dot';
  }
}

async function waitForUgsInstalled(maxRetries = 10, intervalMs = 1000): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const result = await window.studioHub.ugsCheckInstalled();
    console.log('[UGS] waitForUgsInstalled retry', i + 1, '- installed?', result.installed);
    if (result.installed) {
      return true;
    }
  }
  return false;
}

function getConfigValue(config: AppConfig, type: string): string {
  switch (type) {
    case 'jenkins':
      return config.jenkins;
    case 'horde':
      return config.horde;
    default:
      return '';
  }
}

async function handleUgsClick(): Promise<void> {
  if (isInstallingUgs) {
    toast('UGS 正在安装中，请稍候...');
    return;
  }

  isInstallingUgs = true;
  setUgsInstalling(true);

  try {
    setStatus('warning', '正在检查 UGS 安装状态...');
    const result = await window.studioHub.ugsCheckInstalled();

    if (result.installed) {
      setStatus('warning', '正在启动 UGS...');
      const launchResult = await window.studioHub.ugsLaunch();
      if (launchResult.success) {
        toast('UGS 已启动');
        setStatus('ok', '就绪');
      } else {
        toast('启动失败: ' + (launchResult.error || '未知错误'));
        setStatus('error', '启动失败');
      }
      await refreshUgsStatus();
    } else {
      const install = confirm('Unreal Game Sync (UGS) 未安装。\n\n是否下载并安装？');
      if (install) {
        setStatus('warning', '正在下载并安装 UGS...');
        const installResult = await window.studioHub.ugsDownloadAndInstall();
        if (installResult.success) {
          toast('UGS 安装已启动，等待安装完成...\n下载路径: ' + installResult.path);
          const installed = await waitForUgsInstalled();
          await refreshUgsStatus();
          if (installed) {
            toast('UGS 安装完成！');
          } else {
            toast('UGS 安装完成，请手动检查');
          }
          setStatus('ok', '就绪');
        } else {
          toast('安装失败: ' + (installResult.error || '未知错误'));
          setStatus('error', '安装失败');
          await refreshUgsStatus();
        }
      } else {
        setStatus('ok', '就绪');
        await refreshUgsStatus();
      }
    }
  } finally {
    isInstallingUgs = false;
    setUgsInstalling(false);
  }
}

async function handlePipeline(type: string, config: AppConfig): Promise<void> {
  if (type === 'env') {
    const val = config.envScript;
    if (!val?.trim()) {
      toast('入口未配置，请先打开配置面板');
      return;
    }
    setStatus('warning', '正在执行环境配置...');
    showLogPanel();
    const result = await window.studioHub.runScript(val);
    if (result.success) {
      toast('环境配置已启动');
      setStatus('ok', '就绪');
    } else {
      toast(`脚本执行失败: ${result.error}`);
      setStatus('error', '脚本执行失败');
    }
  } else {
    const val = getConfigValue(config, type);
    if (!val?.trim()) {
      toast('入口未配置，请先打开配置面板');
      return;
    }
    await window.studioHub.openUrl(val);
    toast('已打开 ' + type.toUpperCase());
  }
}
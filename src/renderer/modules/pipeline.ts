import type { AppConfig } from '../../types/config';
import { toast, setStatus } from '../utils';
import { showLogPanel } from './log-panel';

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

  const result = await window.studioHub.ugsCheckInstalled();
  console.log('[UGS] refreshUgsStatus - installed?', result.installed, 'path:', result.path);

  if (card) {
    card.classList.toggle('disabled', !result.installed);
  }
  if (dot) {
    dot.className = result.installed ? 'pipeline-status-dot ready' : 'pipeline-status-dot';
  }
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
  } else {
    const install = confirm('Unreal Game Sync (UGS) 未安装。\n\n是否下载并安装？');
    if (install) {
      setStatus('warning', '正在下载并安装 UGS...');
      const installResult = await window.studioHub.ugsDownloadAndInstall();
      if (installResult.success) {
        toast('UGS 安装已启动，请在安装完成后重新点击');
        await refreshUgsStatus();
        setStatus('ok', '就绪');
      } else {
        toast('安装失败: ' + (installResult.error || '未知错误'));
        setStatus('error', '安装失败');
      }
    } else {
      setStatus('ok', '就绪');
    }
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
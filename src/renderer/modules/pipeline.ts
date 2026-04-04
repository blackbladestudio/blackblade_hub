import type { AppConfig } from '../../types/config';
import { toast, setStatus } from '../utils';
import { showLogPanel } from './log-panel';

export function initPipeline(getConfig: () => AppConfig): void {
  document.getElementById('card-ugs')!.addEventListener('click', () =>
    handlePipeline('ugs', getConfig()),
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

function getConfigValue(config: AppConfig, type: string): string {
  switch (type) {
    case 'jenkins':
      return config.jenkins;
    case 'horde':
      return config.horde;
    case 'ugs':
      return config.ugs;
    default:
      return '';
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

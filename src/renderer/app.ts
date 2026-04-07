import type { AppConfig } from '../types/config';
import type { StudioHubAPI } from '../types/ipc';
import { initLaunch, renderToolsColumn } from './modules/launch';
import { initPipeline, refreshUgsStatus } from './modules/pipeline';
import { initToolbox, refreshHordeAgentStatus } from './modules/toolbox';
import { initConfigModal } from './modules/config-modal';
import { initLogPanel, appendLog } from './modules/log-panel';
import { initLauncher } from './modules/launcher';

declare global {
  interface Window {
    studioHub: StudioHubAPI;
  }
}

let config: AppConfig = {
  uprojectPath: '',
  tools: [],
  jenkins: '',
  horde: '',
  envScript: '',
  minio: { endpoint: 'http://10.248.15.20:9000', accessKey: '', secretKey: '', bucket: 'builds-client' },
  launcher: { installDir: '', prefix: '', exeRelativePath: '' },
};

function getConfig(): AppConfig {
  return config;
}

function setConfigAndRender(newConfig: AppConfig): void {
  config = newConfig;
  renderUI();
}

async function loadAppConfig(): Promise<void> {
  config = await window.studioHub.getConfig();
  renderUI();
}

function renderUI(): void {
  renderToolsColumn(config);

  const pipelineMap = [
    { key: 'jenkins', val: config.jenkins },
    { key: 'horde', val: config.horde },
    { key: 'env', val: config.envScript },
  ];

  for (const { key, val } of pipelineMap) {
    const card = document.getElementById('card-' + key);
    const dot = document.getElementById('dot-' + key);
    if (card) card.classList.toggle('disabled', !val?.trim());
    if (dot) dot.className = val?.trim() ? 'pipeline-status-dot ready' : 'pipeline-status-dot';
  }

  refreshHordeAgentStatus();
  refreshUgsStatus();
}

window.addEventListener('DOMContentLoaded', async () => {
  setTimeout(() => {
    document.getElementById('startup-overlay')?.classList.add('hidden');
  }, 2200);

  initLaunch(getConfig);
  initPipeline(getConfig);
  initToolbox();
  initConfigModal(getConfig, setConfigAndRender);
  initLogPanel();
  initLauncher(getConfig);

  document.getElementById('btn-minimize')!.addEventListener('click', () => window.studioHub.winMinimize());
  document.getElementById('btn-maximize')!.addEventListener('click', () => window.studioHub.winMaximize());
  document.getElementById('btn-close')!.addEventListener('click', () => window.studioHub.winClose());

  window.studioHub.onScriptLog(({ type, msg }) => appendLog(type, msg));

  await loadAppConfig();
});

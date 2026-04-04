import type { AppConfig } from '../types/config';
import type { StudioHubAPI } from '../types/ipc';
import { initLaunch, renderToolsColumn } from './modules/launch';
import { initPipeline } from './modules/pipeline';
import { initToolbox, refreshHordeAgentStatus } from './modules/toolbox';
import { initConfigModal } from './modules/config-modal';
import { initLogPanel, appendLog } from './modules/log-panel';

declare global {
  interface Window {
    studioHub: StudioHubAPI;
  }
}

let config: AppConfig = {
  gameExe: '',
  editorExe: '',
  tools: [],
  jenkins: '',
  horde: '',
  ugs: '',
  envScript: '',
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
  const gameEl = document.getElementById('launch-game');
  const editorEl = document.getElementById('launch-editor');

  gameEl?.classList.toggle('disabled', !config.gameExe?.trim());
  editorEl?.classList.toggle('disabled', !config.editorExe?.trim());

  renderToolsColumn(config);

  const pipelineMap = [
    { key: 'jenkins', val: config.jenkins },
    { key: 'horde', val: config.horde },
    { key: 'ugs', val: config.ugs },
    { key: 'env', val: config.envScript },
  ];

  for (const { key, val } of pipelineMap) {
    const card = document.getElementById('card-' + key);
    const dot = document.getElementById('dot-' + key);
    if (card) card.classList.toggle('disabled', !val?.trim());
    if (dot) dot.className = val?.trim() ? 'pipeline-status-dot ready' : 'pipeline-status-dot';
  }

  refreshHordeAgentStatus();
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

  document.getElementById('btn-minimize')!.addEventListener('click', () => window.studioHub.winMinimize());
  document.getElementById('btn-maximize')!.addEventListener('click', () => window.studioHub.winMaximize());
  document.getElementById('btn-close')!.addEventListener('click', () => window.studioHub.winClose());

  window.studioHub.onScriptLog(({ type, msg }) => appendLog(type, msg));

  await loadAppConfig();
});

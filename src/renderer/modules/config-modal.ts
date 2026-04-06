import type { AppConfig, ToolEntry } from '../../types/config';
import { toast, escHtml } from '../utils';

let onConfigSaved: ((config: AppConfig) => void) | null = null;
let getConfigRef: (() => AppConfig) | null = null;

export function initConfigModal(
  getConfig: () => AppConfig,
  onSave: (config: AppConfig) => void,
): void {
  getConfigRef = getConfig;
  onConfigSaved = onSave;

  document.getElementById('btn-config')!.addEventListener('click', openConfig);
  document.getElementById('cfg-close')!.addEventListener('click', closeConfig);
  document.getElementById('config-overlay')!.addEventListener('click', (e) => {
    if (e.target === document.getElementById('config-overlay')) closeConfig();
  });

  document.getElementById('btn-save-config')!.addEventListener('click', saveConfig);
  document.getElementById('btn-cancel-config')!.addEventListener('click', closeConfig);
  document.getElementById('btn-add-tool')!.addEventListener('click', addToolEntry);

  document.getElementById('btn-browse-game')!.addEventListener('click', () => browseFile('cfg-game'));
  document.getElementById('btn-browse-editor')!.addEventListener('click', () => browseFile('cfg-editor'));
  document.getElementById('btn-browse-ugs')!.addEventListener('click', () => browseFile('cfg-ugs'));
  document.getElementById('btn-browse-env')!.addEventListener('click', () => browseFile('cfg-env'));

  document.getElementById('btn-browse-install-dir')!.addEventListener('click', async () => {
    const dir = await window.studioHub.launcherSelectInstallDir();
    if (dir) {
      (document.getElementById('cfg-launcher-install-dir') as HTMLInputElement).value = dir;
    }
  });

  document.getElementById('btn-toggle-secret')!.addEventListener('click', () => {
    const input = document.getElementById('cfg-minio-secret-key') as HTMLInputElement;
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
  });
}

function openConfig(): void {
  const config = getConfigRef!();
  (document.getElementById('cfg-game') as HTMLInputElement).value = config.gameExe || '';
  (document.getElementById('cfg-editor') as HTMLInputElement).value = config.editorExe || '';
  (document.getElementById('cfg-jenkins') as HTMLInputElement).value = config.jenkins || '';
  (document.getElementById('cfg-horde') as HTMLInputElement).value = config.horde || '';
  (document.getElementById('cfg-ugs') as HTMLInputElement).value = config.ugs || '';
  (document.getElementById('cfg-env') as HTMLInputElement).value = config.envScript || '';

  const minio = config.minio || { endpoint: '', accessKey: '', secretKey: '', bucket: '' };
  const launcher = config.launcher || { installDir: '', prefix: '', exeRelativePath: '' };
  (document.getElementById('cfg-minio-endpoint') as HTMLInputElement).value = minio.endpoint || '';
  (document.getElementById('cfg-minio-access-key') as HTMLInputElement).value = minio.accessKey || '';
  (document.getElementById('cfg-minio-secret-key') as HTMLInputElement).value = minio.secretKey || '';
  (document.getElementById('cfg-minio-bucket') as HTMLInputElement).value = minio.bucket || 'builds-client';
  (document.getElementById('cfg-launcher-prefix') as HTMLInputElement).value = launcher.prefix || '';
  (document.getElementById('cfg-launcher-exe') as HTMLInputElement).value = launcher.exeRelativePath || '';
  (document.getElementById('cfg-launcher-install-dir') as HTMLInputElement).value = launcher.installDir || '';

  renderToolsEditor(config);
  document.getElementById('config-overlay')!.classList.add('visible');
}

function closeConfig(): void {
  document.getElementById('config-overlay')!.classList.remove('visible');
}

function renderToolsEditor(config: AppConfig): void {
  const list = document.getElementById('cfg-tools-list')!;
  list.innerHTML = '';
  const tools = Array.isArray(config.tools) ? config.tools : [];
  tools.forEach((tool, i) => {
    list.appendChild(createToolEntry(tool.label || '', tool.path || '', i));
  });
}

function createToolEntry(label: string, toolPath: string, idx: number): HTMLElement {
  const div = document.createElement('div');
  div.className = 'tool-entry';
  div.dataset.idx = String(idx);
  div.innerHTML = `
    <input class="tool-entry-label" type="text" value="${escHtml(label)}" placeholder="名称" />
    <input class="tool-entry-path"  type="text" value="${escHtml(toolPath)}"  placeholder="路径..." />
    <button class="tool-entry-browse" title="浏览">📁</button>
    <button class="tool-entry-remove" title="删除">✕</button>
  `;

  div.querySelector('.tool-entry-browse')!.addEventListener('click', async () => {
    const pathInput = div.querySelector('.tool-entry-path') as HTMLInputElement;
    const result = await window.studioHub.selectFile(pathInput.value);
    if (result) pathInput.value = result;
  });

  div.querySelector('.tool-entry-remove')!.addEventListener('click', () => {
    div.remove();
  });

  return div;
}

function addToolEntry(): void {
  const list = document.getElementById('cfg-tools-list')!;
  const idx = list.children.length;
  list.appendChild(createToolEntry('', '', idx));
}

async function browseFile(inputId: string): Promise<void> {
  const input = document.getElementById(inputId) as HTMLInputElement;
  const result = await window.studioHub.selectFile(input.value);
  if (result) input.value = result;
}

async function saveConfig(): Promise<void> {
  const toolEntries = Array.from(document.getElementById('cfg-tools-list')!.children);
  const tools: ToolEntry[] = toolEntries
    .map((entry) => ({
      label: (entry.querySelector('.tool-entry-label') as HTMLInputElement).value.trim(),
      path: (entry.querySelector('.tool-entry-path') as HTMLInputElement).value.trim(),
    }))
    .filter((t) => t.label || t.path);

  const newCfg: AppConfig = {
    gameExe: (document.getElementById('cfg-game') as HTMLInputElement).value.trim(),
    editorExe: (document.getElementById('cfg-editor') as HTMLInputElement).value.trim(),
    tools,
    jenkins: (document.getElementById('cfg-jenkins') as HTMLInputElement).value.trim(),
    horde: (document.getElementById('cfg-horde') as HTMLInputElement).value.trim(),
    ugs: (document.getElementById('cfg-ugs') as HTMLInputElement).value.trim(),
    envScript: (document.getElementById('cfg-env') as HTMLInputElement).value.trim(),
    minio: {
      endpoint: (document.getElementById('cfg-minio-endpoint') as HTMLInputElement).value.trim(),
      accessKey: (document.getElementById('cfg-minio-access-key') as HTMLInputElement).value.trim(),
      secretKey: (document.getElementById('cfg-minio-secret-key') as HTMLInputElement).value.trim(),
      bucket: (document.getElementById('cfg-minio-bucket') as HTMLInputElement).value.trim() || 'builds-client',
    },
    launcher: {
      installDir: (document.getElementById('cfg-launcher-install-dir') as HTMLInputElement).value.trim(),
      prefix: (document.getElementById('cfg-launcher-prefix') as HTMLInputElement).value.trim(),
      exeRelativePath: (document.getElementById('cfg-launcher-exe') as HTMLInputElement).value.trim(),
    },
  };

  await window.studioHub.saveConfig(newCfg);
  onConfigSaved?.(newCfg);
  closeConfig();
  toast('配置已保存');
}

import type { AppConfig, ToolEntry } from '../../types/config';
import { DEFAULT_P4_SERVER } from '../../types/config';
import { toast, escHtml } from '../utils';

let onConfigSaved: ((config: AppConfig) => void) | null = null;
let getConfigRef: (() => AppConfig) | null = null;
let p4RefreshTimer: ReturnType<typeof setTimeout> | null = null;
let savedP4Workspace = '';

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

  document.getElementById('btn-browse-uproject')!.addEventListener('click', async () => {
    const input = document.getElementById('cfg-uproject') as HTMLInputElement;
    const result = await window.studioHub.selectUproject();
    if (result) {
      input.value = result;
      scheduleP4WorkspaceRefresh();
    }
  });
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

  for (const id of ['cfg-p4-server', 'cfg-p4-username', 'cfg-uproject']) {
    document.getElementById(id)!.addEventListener('input', scheduleP4WorkspaceRefresh);
  }
}

function scheduleP4WorkspaceRefresh(): void {
  if (p4RefreshTimer) clearTimeout(p4RefreshTimer);
  p4RefreshTimer = setTimeout(() => void refreshP4Workspaces(), 400);
}

async function refreshP4Workspaces(): Promise<void> {
  const select = document.getElementById('cfg-p4-workspace') as HTMLSelectElement;
  const hint = document.getElementById('cfg-p4-workspace-hint')!;
  const server = (document.getElementById('cfg-p4-server') as HTMLInputElement).value.trim() || DEFAULT_P4_SERVER;
  const userName = (document.getElementById('cfg-p4-username') as HTMLInputElement).value.trim();
  const uprojectPath = (document.getElementById('cfg-uproject') as HTMLInputElement).value.trim();

  if (!userName || !uprojectPath) {
    select.innerHTML = '<option value="">请先填写 User Name 和 UE 项目</option>';
    select.disabled = true;
    hint.textContent = '';
    return;
  }

  // 如果下拉框已有可选项，不清空，等结果回来再更新，避免闪烁
  const hasExistingOptions = select.options.length > 0 && select.options[0].value !== '';

  if (!hasExistingOptions) {
    select.disabled = true;
    select.innerHTML = '<option value="">检测中...</option>';
    hint.textContent = '';
  }

  const result = await window.studioHub.ugsListWorkspaces({ server, userName, uprojectPath });

  if (!result.success) {
    select.innerHTML = `<option value="">${escHtml(result.error || '检测失败')}</option>`;
    select.disabled = true;
    hint.textContent = '';
    return;
  }

  const workspaces = result.workspaces ?? [];
  if (workspaces.length === 0) {
    select.innerHTML = '<option value="">No Workspaces found!</option>';
    select.disabled = true;
    hint.textContent = `本机 ${result.localHost}，服务器共 ${result.totalCount} 个，过滤后 0 个`;
    return;
  }

  select.innerHTML = '';
  for (const ws of workspaces) {
    const opt = document.createElement('option');
    opt.value = ws.name;
    opt.textContent = ws.name;
    opt.title = `Host: ${ws.host || '(any)'} | Root: ${ws.root || 'null'}`;
    select.appendChild(opt);
  }

  const preferred = savedP4Workspace || select.value;
  if (preferred && workspaces.some((ws) => ws.name === preferred)) {
    select.value = preferred;
  } else if (workspaces.length === 1) {
    select.value = workspaces[0].name;
  }

  select.disabled = false;
  hint.textContent = `本机 ${result.localHost}，过滤后 ${workspaces.length} / ${result.totalCount} 个`;
}

// 将当前配置预填到表单，避免打开配置面板时从空到填充的闪烁
export function prefillConfigForm(config: AppConfig): void {
  (document.getElementById('cfg-uproject') as HTMLInputElement).value = config.uprojectPath || '';
  const p4 = config.perforce || { server: DEFAULT_P4_SERVER, userName: '', workspace: '' };
  (document.getElementById('cfg-p4-server') as HTMLInputElement).value = p4.server || DEFAULT_P4_SERVER;
  (document.getElementById('cfg-p4-username') as HTMLInputElement).value = p4.userName || '';
  savedP4Workspace = p4.workspace || '';

  // workspace 下拉框：如果有保存的 workspace，先放一个选项占位
  if (p4.workspace) {
    const select = document.getElementById('cfg-p4-workspace') as HTMLSelectElement;
    select.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = p4.workspace;
    opt.textContent = p4.workspace;
    select.appendChild(opt);
    select.value = p4.workspace;
    select.disabled = false;
  }

  (document.getElementById('cfg-jenkins') as HTMLInputElement).value = config.jenkins || '';
  (document.getElementById('cfg-horde') as HTMLInputElement).value = config.horde || '';
  (document.getElementById('cfg-env') as HTMLInputElement).value = config.envScript || '';

  const minio = config.minio || { endpoint: '', accessKey: '', secretKey: '', bucket: '', maxWorkers: undefined };
  const launcher = config.launcher || { installDir: '', prefix: '', exeRelativePath: '' };
  (document.getElementById('cfg-minio-endpoint') as HTMLInputElement).value = minio.endpoint || '';
  (document.getElementById('cfg-minio-access-key') as HTMLInputElement).value = minio.accessKey || '';
  (document.getElementById('cfg-minio-secret-key') as HTMLInputElement).value = minio.secretKey || '';
  (document.getElementById('cfg-minio-bucket') as HTMLInputElement).value = minio.bucket || 'builds-client';
  (document.getElementById('cfg-minio-workers') as HTMLInputElement).value = minio.maxWorkers ? String(minio.maxWorkers) : '';
  (document.getElementById('cfg-launcher-prefix') as HTMLInputElement).value = launcher.prefix || '';
  (document.getElementById('cfg-launcher-exe') as HTMLInputElement).value = launcher.exeRelativePath || '';
  (document.getElementById('cfg-launcher-install-dir') as HTMLInputElement).value = launcher.installDir || '';
}

async function openConfig(): Promise<void> {
  // 表单已在 prefillConfigForm 中预填，直接显示面板
  const config = getConfigRef!();
  const p4 = config.perforce || { server: DEFAULT_P4_SERVER, userName: '', workspace: '' };

  // userName 或 workspace 为空时，从项目 SourceControlSettings.ini 自动填充
  if (config.uprojectPath?.trim() && (!p4.userName || !p4.workspace)) {
    const autoFill = await window.studioHub.p4AutoFill(config.uprojectPath);
    if (autoFill.userName && !p4.userName) {
      (document.getElementById('cfg-p4-username') as HTMLInputElement).value = autoFill.userName;
    }
    if (autoFill.server && p4.server === DEFAULT_P4_SERVER && autoFill.server !== DEFAULT_P4_SERVER) {
      (document.getElementById('cfg-p4-server') as HTMLInputElement).value = autoFill.server;
    }
    if (autoFill.workspace && !p4.workspace) {
      savedP4Workspace = autoFill.workspace;
    }
  }

  renderToolsEditor(config);
  document.getElementById('config-overlay')!.classList.add('visible');
  scheduleP4WorkspaceRefresh();
}

function closeConfig(): void {
  persistConfig();
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

async function persistConfig(): Promise<AppConfig> {
  const toolEntries = Array.from(document.getElementById('cfg-tools-list')!.children);
  const tools: ToolEntry[] = toolEntries
    .map((entry) => ({
      label: (entry.querySelector('.tool-entry-label') as HTMLInputElement).value.trim(),
      path: (entry.querySelector('.tool-entry-path') as HTMLInputElement).value.trim(),
    }))
    .filter((t) => t.label || t.path);

  const prev = getConfigRef!();
  const newCfg: AppConfig = {
    ...prev,
    uprojectPath: (document.getElementById('cfg-uproject') as HTMLInputElement).value.trim(),
    perforce: {
      server: (document.getElementById('cfg-p4-server') as HTMLInputElement).value.trim() || DEFAULT_P4_SERVER,
      userName: (document.getElementById('cfg-p4-username') as HTMLInputElement).value.trim(),
      workspace: (document.getElementById('cfg-p4-workspace') as HTMLSelectElement).value.trim(),
    },
    tools,
    jenkins: (document.getElementById('cfg-jenkins') as HTMLInputElement).value.trim(),
    horde: (document.getElementById('cfg-horde') as HTMLInputElement).value.trim(),
    envScript: (document.getElementById('cfg-env') as HTMLInputElement).value.trim(),
    minio: {
      endpoint: (document.getElementById('cfg-minio-endpoint') as HTMLInputElement).value.trim(),
      accessKey: (document.getElementById('cfg-minio-access-key') as HTMLInputElement).value.trim(),
      secretKey: (document.getElementById('cfg-minio-secret-key') as HTMLInputElement).value.trim(),
      bucket: (document.getElementById('cfg-minio-bucket') as HTMLInputElement).value.trim() || 'builds-client',
      maxWorkers: parseInt((document.getElementById('cfg-minio-workers') as HTMLInputElement).value) || undefined,
    },
    launcher: {
      installDir: (document.getElementById('cfg-launcher-install-dir') as HTMLInputElement).value.trim(),
      prefix: (document.getElementById('cfg-launcher-prefix') as HTMLInputElement).value.trim(),
      exeRelativePath: (document.getElementById('cfg-launcher-exe') as HTMLInputElement).value.trim(),
    },
  };

  await window.studioHub.saveConfig(newCfg);
  onConfigSaved?.(newCfg);
  return newCfg;
}

async function saveConfig(): Promise<void> {
  await persistConfig();
  closeConfig();
  toast('配置已保存');
}

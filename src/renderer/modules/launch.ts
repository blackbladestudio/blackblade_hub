import type { AppConfig } from '../../types/config';
import { toast, setStatus, escHtml, addRipple } from '../utils';

export function initLaunch(getConfig: () => AppConfig): void {
  const gameEl = document.getElementById('launch-game')!;
  const editorEl = document.getElementById('launch-editor')!;

  gameEl.addEventListener('click', () => handleLaunch('game', getConfig()));
  editorEl.addEventListener('click', () => handleLaunch('editor', getConfig()));

  [gameEl, editorEl].forEach((el) => {
    el.addEventListener('click', (e) => addRipple(el, e));
  });
}

async function handleLaunch(type: 'game' | 'editor', config: AppConfig): Promise<void> {
  const appPath = type === 'game' ? config.gameExe : config.editorExe;
  if (!appPath?.trim()) {
    toast('路径未配置，请打开配置面板设置');
    return;
  }

  setStatus('warning', type === 'game' ? '正在启动游戏...' : '正在启动编辑器...');
  const result = await window.studioHub.launchApp(appPath);

  if (result?.success) {
    toast((type === 'game' ? '游戏' : '编辑器') + ' 已启动');
    setStatus('ok', '就绪');
  } else {
    toast('启动失败: ' + (result?.error || '未知错误'));
    setStatus('error', '启动失败');
  }
}

async function handleToolLaunch(config: AppConfig, idx: number): Promise<void> {
  const tools = Array.isArray(config.tools) ? config.tools : [];
  const tool = tools[idx];
  if (!tool?.path?.trim()) {
    toast('路径未配置');
    return;
  }

  setStatus('warning', '正在启动 ' + (tool.label || '工具') + '...');
  const result = await window.studioHub.launchApp(tool.path);

  if (result?.success) {
    toast((tool.label || '工具') + ' 已启动');
    setStatus('ok', '就绪');
  } else {
    toast('启动失败: ' + (result?.error || '未知错误'));
    setStatus('error', '启动失败');
  }
}

export function renderToolsColumn(config: AppConfig): void {
  const col = document.getElementById('tools-column')!;
  col.innerHTML = '';
  const tools = Array.isArray(config.tools) ? config.tools : [];

  tools.forEach((tool, i) => {
    const btn = document.createElement('button');
    btn.className = 'tool-btn' + (!tool.path?.trim() ? ' disabled' : '');
    btn.innerHTML = `<span class="tool-icon">🔧</span><span class="tool-btn-label">${escHtml(tool.label || '工具' + (i + 1))}</span>`;
    btn.addEventListener('click', () => handleToolLaunch(config, i));
    col.appendChild(btn);
  });

  if (tools.length === 0) {
    const placeholder = document.createElement('div');
    placeholder.style.cssText =
      'font-size:12px;color:var(--muted);text-align:center;padding:14px 0;letter-spacing:1px;';
    placeholder.textContent = '在配置中添加生产工具';
    col.appendChild(placeholder);
  }
}

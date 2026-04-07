import type { AppConfig } from '../../types/config';
import { toast, setStatus, escHtml, addRipple } from '../utils';

export function initLaunch(getConfigRef: () => AppConfig): void {
  const editorEl = document.getElementById('launch-editor')!;
  editorEl.addEventListener('click', () => handleLaunch('editor', getConfigRef));
  editorEl.addEventListener('click', (e) => addRipple(editorEl, e));
}

async function handleLaunch(type: 'game' | 'editor', getConfig: () => AppConfig): Promise<void> {
  const config = getConfig();
  if (type === 'editor') {
    if (!config.uprojectPath?.trim()) {
      toast('未配置 UE 项目，请选择 .uproject 文件');
      const selected = await window.studioHub.selectUproject();
      if (selected) {
        const newConfig = { ...config, uprojectPath: selected };
        await window.studioHub.saveConfig(newConfig);
        const editorResult = await window.studioHub.launchEditor(selected);
        if (editorResult?.success) {
          toast('编辑器已启动');
          setStatus('ok', '就绪');
        } else {
          toast('启动失败: ' + (editorResult?.error || '未知错误'));
          setStatus('error', '启动失败');
        }
      }
      return;
    }

    setStatus('warning', '正在启动编辑器...');
    const result = await window.studioHub.launchEditor(config.uprojectPath);

    if (result?.success) {
      toast('编辑器已启动');
      setStatus('ok', '就绪');
    } else {
      toast('启动失败: ' + (result?.error || '未知错误'));
      setStatus('error', '启动失败');
    }
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

}

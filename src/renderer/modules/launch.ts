import type { AppConfig } from '../../types/config';
import { toast, setStatus, escHtml, addRipple } from '../utils';

export function initLaunch(getConfigRef: () => AppConfig, setConfigRef: (cfg: AppConfig) => void): void {
  const editorEl = document.getElementById('launch-editor')!;
  editorEl.addEventListener('click', () => handleLaunch('editor', getConfigRef, setConfigRef));
  editorEl.addEventListener('click', (e) => addRipple(editorEl, e));

  // 更新按钮：同步 UE 项目到最新 precompiled-binary + content
  const syncBtn = document.getElementById('btn-ugs-sync')!;
  syncBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await handleUgsSync(getConfigRef);
  });
}

async function handleUgsSync(getConfig: () => AppConfig): Promise<void> {
  const config = getConfig();
  if (!config.uprojectPath?.trim()) {
    toast('未配置 UE 项目，请先选择 .uproject 文件');
    return;
  }

  // 检查 UGS 是否已安装，未安装则弹窗提示
  const ugsStatus = await window.studioHub.ugsCheckInstalled();
  if (!ugsStatus.installed) {
    const install = confirm('Unreal Game Sync (UGS) 未安装，无法同步预编译二进制。\n\n是否下载并安装？');
    if (install) {
      const installResult = await window.studioHub.ugsDownloadAndInstall();
      if (installResult.success) {
        toast('UGS 安装已启动，安装完成后请重新点击更新');
      } else {
        toast('安装失败: ' + (installResult.error || '未知错误'));
      }
    }
    return;
  }

  const editorEl = document.getElementById('launch-editor')!;
  const syncBtn = document.getElementById('btn-ugs-sync')!;
  const syncLabel = syncBtn.querySelector('span')!;

  // 进入同步状态
  editorEl.classList.add('syncing');
  syncLabel.textContent = '同步中...';
  setStatus('warning', '正在同步项目...');
  toast('开始同步项目，详见下方日志面板');

  const result = await window.studioHub.ugsSyncProject(config.uprojectPath);

  // 恢复正常状态
  editorEl.classList.remove('syncing');
  syncLabel.textContent = '更新';

  if (result.success) {
    toast('项目同步完成！可以启动编辑器');
    setStatus('ok', '就绪');
  } else {
    toast('同步失败: ' + (result.error || '未知错误'));
    setStatus('error', '同步失败');
  }
}

async function handleLaunch(type: 'game' | 'editor', getConfig: () => AppConfig, setConfig?: (cfg: AppConfig) => void): Promise<void> {
  const config = getConfig();
  if (type === 'editor') {
    if (!config.uprojectPath?.trim()) {
      toast('未配置 UE 项目，请选择 .uproject 文件');
      const selected = await window.studioHub.selectUproject();
      if (selected) {
        const newConfig = { ...config, uprojectPath: selected };
        await window.studioHub.saveConfig(newConfig);
        setConfig?.(newConfig);
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

import { toast } from '../utils';
import type { AppConfig } from '../../types/config';

let currentUrl: string = '';
let _getConfig: (() => AppConfig) | null = null;

export function initAiSites(getConfig: () => AppConfig): void {
  _getConfig = getConfig;

  document.getElementById('card-ai-sites')!.addEventListener('click', () => {
    refreshStudioChatUrl();
    showAiSitesPage();
  });
  document.getElementById('ai-sites-back')!.addEventListener('click', hideAiSitesPage);
  document.getElementById('ai-sites-sidebar-toggle')!.addEventListener('click', toggleSidebar);
  document.getElementById('ai-sites-sidebar-expand')!.addEventListener('click', toggleSidebar);

  document.querySelectorAll('.ai-site-item').forEach((item) => {
    item.addEventListener('click', () => {
      const url = item.getAttribute('data-url');
      if (url) loadUrl(url);
    });
  });

  document.getElementById('ai-sites-btn-back')!.addEventListener('click', () => {
    const wv = getWebview();
    if (wv?.canGoBack()) wv.goBack();
  });

  document.getElementById('ai-sites-btn-forward')!.addEventListener('click', () => {
    const wv = getWebview();
    if (wv?.canGoForward()) wv.goForward();
  });

  document.getElementById('ai-sites-btn-refresh')!.addEventListener('click', () => {
    getWebview()?.reload();
  });

  document.getElementById('ai-sites-btn-external')!.addEventListener('click', () => {
    if (currentUrl) window.studioHub.openUrl(currentUrl);
  });

  const webview = getWebview();
  if (webview) {
    webview.addEventListener('did-navigate', updateNavState);
    webview.addEventListener('did-navigate-in-page', updateNavState);
    webview.addEventListener('did-start-loading', () => {
      document.getElementById('ai-sites-loading')!.style.display = '';
    });
    webview.addEventListener('did-stop-loading', () => {
      document.getElementById('ai-sites-loading')!.style.display = 'none';
    });

    // 支持 Ctrl+滚轮缩放页面
    webview.addEventListener('dom-ready', () => {
      webview.setZoomFactor(1.0);
    });
    webview.addEventListener('wheel', (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const wv = getWebview();
        if (!wv) return;
        wv.getZoomFactor((factor: number) => {
          const delta = e.deltaY > 0 ? -0.1 : 0.1;
          const next = Math.min(3.0, Math.max(0.3, factor + delta));
          wv.setZoomFactor(next);
        });
      }
    }, { passive: false });
  }
}

/** config 更新后刷新 Studio Chat URL（由 app.ts 在 config 变更时调用） */
export function refreshStudioChatUrl(): void {
  if (!_getConfig) return;
  const url = _getConfig().studioChat?.trim() || '';
  const item = document.getElementById('ai-site-studio-chat');
  if (!item) return;
  item.setAttribute('data-url', url);
  // 若当前未配置则置灰
  item.classList.toggle('disabled-item', !url);
}

function getWebview(): Electron.WebviewTag | null {
  return document.getElementById('ai-sites-webview') as Electron.WebviewTag | null;
}

function updateNavState(): void {
  const wv = getWebview();
  if (!wv) return;
  currentUrl = wv.getURL();

  const btnBack = document.getElementById('ai-sites-btn-back') as HTMLButtonElement;
  const btnForward = document.getElementById('ai-sites-btn-forward') as HTMLButtonElement;
  const urlBar = document.getElementById('ai-sites-url')!;

  btnBack.disabled = !wv.canGoBack();
  btnForward.disabled = !wv.canGoForward();
  urlBar.textContent = currentUrl;

  document.querySelectorAll('.ai-site-item').forEach((item) => {
    const itemUrl = item.getAttribute('data-url') || '';
    item.classList.toggle('active', currentUrl.startsWith(itemUrl));
  });
}

function showAiSitesPage(): void {
  document.getElementById('ai-sites-page')!.classList.remove('page-hidden');
}

function hideAiSitesPage(): void {
  document.getElementById('ai-sites-page')!.classList.add('page-hidden');
}

function toggleSidebar(): void {
  const sidebar = document.getElementById('ai-sites-sidebar')!;
  const btn = document.getElementById('ai-sites-sidebar-toggle')!;
  sidebar.classList.toggle('collapsed');

  const isCollapsed = sidebar.classList.contains('collapsed');
  btn.title = isCollapsed ? '展开侧边栏' : '折叠侧边栏';
  const svg = btn.querySelector('svg')!;
  svg.innerHTML = isCollapsed
    ? `<path d="M6 4L9 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="M10 4L7 8L10 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  const text = btn.querySelector('.ai-sites-toggle-text') as HTMLElement;
  if (text) text.textContent = isCollapsed ? '展开' : '折叠';
}

function loadUrl(url: string): void {
  const welcome = document.getElementById('ai-sites-welcome')!;
  const webviewWrap = document.getElementById('ai-sites-webview-wrap')!;

  welcome.style.display = 'none';
  webviewWrap.style.display = '';

  const webview = getWebview();
  if (webview) {
    webview.src = url;
    currentUrl = url;
    document.getElementById('ai-sites-url')!.textContent = url;
    toast(`正在加载 ${new URL(url).hostname}`);
  }

  document.querySelectorAll('.ai-site-item').forEach((item) => {
    const itemUrl = item.getAttribute('data-url') || '';
    item.classList.toggle('active', url.startsWith(itemUrl));
  });
}

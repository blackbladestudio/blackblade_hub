import type { AppConfig } from '../../types/config';
import { toast } from '../utils';

type PortalKey = 'studioHome' | 'studioHue';

const CARD_IDS: Record<PortalKey, string> = {
  studioHome: 'card-studio-home',
  studioHue: 'card-studio-hue',
};

const DOT_IDS: Record<PortalKey, string> = {
  studioHome: 'dot-studio-home',
  studioHue: 'dot-studio-hue',
};

const LABELS: Record<PortalKey, string> = {
  studioHome: 'Studio Home',
  studioHue: 'Hue',
};

function getPortalUrl(config: AppConfig, key: PortalKey): string {
  const v = config[key];
  return typeof v === 'string' ? v : '';
}

export function initStudioPortal(getConfig: () => AppConfig): void {
  (['studioHome', 'studioHue'] as PortalKey[]).forEach((key) => {
    document.getElementById(CARD_IDS[key])!.addEventListener('click', () =>
      void handlePortalClick(key, getConfig()),
    );
  });
}

/** 根据配置更新卡片的可用状态与状态点 */
export function refreshStudioPortalCards(config: AppConfig): void {
  (['studioHome', 'studioHue'] as PortalKey[]).forEach((key) => {
    const val = getPortalUrl(config, key).trim();
    const card = document.getElementById(CARD_IDS[key]);
    const dot = document.getElementById(DOT_IDS[key]);
    if (card) card.classList.toggle('disabled', !val);
    if (dot) dot.className = val ? 'pipeline-status-dot ready' : 'pipeline-status-dot';
  });
}

async function handlePortalClick(key: PortalKey, config: AppConfig): Promise<void> {
  const url = getPortalUrl(config, key).trim();
  if (!url) {
    toast('入口未配置，请先打开配置面板');
    return;
  }
  await window.studioHub.openUrl(url);
  toast(`已打开 ${LABELS[key]}`);
}

import { ipcMain, net, shell } from 'electron';
import type { BuilderSite } from '../../types/ipc';

// 目录无需登录，复用 Hub 已使用的内网 HTTP 入口；打开应用时使用正式 HTTPS 分享地址。
const directory = 'http://inner.blackblade.com/sites/api/sites';
const workspace = 'https://inner.blackblade.com/sites/';

function isSiteSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+)*$/u.test(value) &&
    value.trim() === value && [...value].length <= 64;
}

async function listSites(): Promise<BuilderSite[]> {
  const response = await net.fetch(directory, {
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('站点目录暂不可用');
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error('站点目录格式无效');
  return rows.flatMap((row): BuilderSite[] => {
    if (!row || !isSiteSlug(row.slug) || typeof row.title !== 'string' || typeof row.owner_name !== 'string') return [];
    return [{
      slug: row.slug,
      title: row.title,
      author: row.owner_name,
      iconUrl: row.has_icon === true ? directory + '/' + encodeURIComponent(row.slug) + '/icon' : null,
    }];
  });
}

export function registerBuilderHandlers(): void {
  ipcMain.handle('builder:list-sites', listSites);
  ipcMain.handle('builder:open-site', async (_event, slug: unknown) => {
    if (!isSiteSlug(slug)) throw new Error('站点地址无效');
    await shell.openExternal(workspace + 'view/' + encodeURIComponent(slug) + '/');
  });
  ipcMain.handle('builder:open-workspace', async (_event, action: unknown) => {
    if (action !== 'publish' && action !== 'mine') throw new Error('无效的 BUILDER 操作');
    const url = new URL(workspace);
    url.searchParams.set('action', action);
    await shell.openExternal(url.href);
  });
}

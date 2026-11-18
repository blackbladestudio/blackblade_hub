import { app, shell } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const API = 'https://api.github.com';
const RELEASES = '/repos/blackbladestudio/blackblade_hub/releases';
const VERSION = /^\d+\.\d+\.\d+$/;

export interface UpdateInfo {
  version: string;
  notes: string;
  url: string;
  date: string;
  size: number;
  sha256?: string;
}

export interface UpdateStatus {
  available: boolean;
  currentVersion: string;
  updateInfo?: UpdateInfo;
  error?: string;
}

function githubHeaders(accept: string): Record<string, string> {
  const token = process.env.STUDIO_HUB_GITHUB_TOKEN?.trim();
  return {
    Accept: accept,
    'User-Agent': 'BlackBlade-Studio-Hub',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function parseRelease(release: any): UpdateInfo {
  const version = typeof release?.tag_name === 'string' && release.tag_name.startsWith('v')
    ? release.tag_name.slice(1) : '';
  if (!VERSION.test(version) || release.draft || release.prerelease || !Array.isArray(release.assets)) {
    throw new Error('GitHub Release 版本格式无效');
  }
  const names = [`BlackBlade.Hub.Setup.${version}.exe`, `BlackBlade Hub Setup ${version}.exe`];
  const assets = release.assets.filter((asset: any) => asset && names.includes(asset.name));
  const asset = assets[0];
  if (assets.length !== 1 || !Number.isSafeInteger(asset.id) || asset.id <= 0
      || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error('GitHub Release 缺少唯一的 Windows 安装包');
  }
  const digest = typeof asset.digest === 'string' ? /^sha256:([a-f\d]{64})$/i.exec(asset.digest) : null;
  return {
    version,
    notes: typeof release.body === 'string' ? release.body : '',
    url: `${API}${RELEASES}/assets/${asset.id}`,
    date: typeof release.published_at === 'string' ? release.published_at : '',
    size: asset.size,
    sha256: digest?.[1].toLowerCase(),
  };
}

function isNewer(version: string, current: string): boolean {
  if (!VERSION.test(current)) throw new Error('当前 Hub 版本格式无效');
  const parts = current.split('.').map(Number);
  for (const [i, part] of version.split('.').map(Number).entries()) {
    if (part !== parts[i]) return part > parts[i];
  }
  return false;
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  const currentVersion = app.getVersion();
  try {
    const response = await fetch(`${API}${RELEASES}/latest`, {
      headers: githubHeaders('application/vnd.github+json'),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 || response.status === 401) {
        throw new Error('无法读取 GitHub Release，请检查 STUDIO_HUB_GITHUB_TOKEN 是否有仓库读取权限');
      }
      throw new Error(`GitHub 检查更新失败：HTTP ${response.status}`);
    }
    const updateInfo = parseRelease(await response.json());
    return { available: isNewer(updateInfo.version, currentVersion), currentVersion, updateInfo };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[updater] check failed:', error);
    return { available: false, currentVersion, error };
  }
}

let downloading = false;

export async function downloadAndInstall(status: UpdateStatus): Promise<void> {
  const info = status.updateInfo;
  if (!status.available || !info) throw new Error('没有可用更新');
  if (downloading) throw new Error('正在下载更新');
  downloading = true;
  let tempDir: string | undefined;
  try {
    if (!/^https:\/\/api\.github\.com\/repos\/blackbladestudio\/blackblade_hub\/releases\/assets\/[1-9]\d*$/.test(info.url)) {
      throw new Error('GitHub 安装包地址无效');
    }
    const signal = AbortSignal.timeout(15 * 60_000);
    let response = await fetch(info.url, {
      headers: githubHeaders('application/octet-stream'),
      redirect: 'manual',
      signal,
    });
    if (response.status === 302) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('GitHub 未返回安装包下载地址');
      const url = new URL(location);
      if (url.origin !== 'https://release-assets.githubusercontent.com') {
        throw new Error('GitHub 安装包跳转地址无效');
      }
      // 令牌只发给 GitHub API，不传给安装包 CDN。
      response = await fetch(url, { redirect: 'error', signal });
    }
    if (response.status !== 200 || !response.body || response.headers.get('content-type')?.includes('json')) {
      await response.body?.cancel();
      throw new Error(`GitHub 安装包下载失败：HTTP ${response.status}`);
    }

    tempDir = await mkdtemp(path.join(app.getPath('temp'), 'studio-hub-update-'));
    const tempPath = path.join(tempDir, 'Studio-Hub-Setup.exe');
    const hash = createHash('sha256');
    let bytes = 0;
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > info.size) return done(new Error('安装包超出 GitHub 公布的大小'));
        hash.update(chunk);
        done(null, chunk);
      },
    }), createWriteStream(tempPath, { flags: 'wx' }), { signal });
    if (bytes !== info.size || (info.sha256 && hash.digest('hex') !== info.sha256)) {
      throw new Error('安装包校验失败');
    }
    const error = await shell.openPath(tempPath);
    if (error) throw new Error(error);
    tempDir = undefined;
  } finally {
    downloading = false;
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

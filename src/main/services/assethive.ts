import path from 'path';

export const ASSETHIVE_REPOSITORY = 'blackbladestudio/AssetHive';
export const ASSETHIVE_PRODUCT_NAME = 'AssetHive';
export const ASSETHIVE_PUBLISHER = 'BlackBlade Studio';

export interface GitHubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

export interface GitHubReleasePayload {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

export interface AssetHiveReleaseAssets {
  version: string;
  installerName: string;
  installerUrl: string;
  installerType: 'inno' | 'msi';
  checksumName: string;
  checksumUrl: string;
  releaseUrl: string;
}

export function normalizeVersion(value: unknown): string | null {
  const normalized = String(value ?? '').trim().replace(/^v/i, '');
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:\.0)?$/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

export function selectReleaseAssets(payload: GitHubReleasePayload): AssetHiveReleaseAssets {
  if (payload.draft === true || payload.prerelease === true) {
    throw new Error('Latest AssetHive release is not stable');
  }
  const version = normalizeVersion(payload.tag_name);
  if (!version) {
    throw new Error('Latest AssetHive release has an invalid version tag');
  }
  const assets = Array.isArray(payload.assets) ? (payload.assets as GitHubReleaseAsset[]) : [];
  const exeName = `AssetHive-${version}-setup-win64.exe`;
  const installerType = assets.some((asset) => asset.name === exeName) ? 'inno' : 'msi';
  const installerName = installerType === 'inno' ? exeName : `AssetHive-${version}-Windows.msi`;
  const checksumName = `${installerName}.sha256`;
  const installerMatches = assets.filter((asset) => asset.name === installerName);
  const checksumMatches = assets.filter((asset) => asset.name === checksumName);
  if (installerMatches.length !== 1 || checksumMatches.length !== 1) {
    throw new Error('Latest AssetHive release must contain one exact installer/checksum pair');
  }
  const installerUrl = validateReleaseUrl(installerMatches[0].browser_download_url);
  const checksumUrl = validateReleaseUrl(checksumMatches[0].browser_download_url);
  return {
    version,
    installerName,
    installerUrl,
    installerType,
    checksumName,
    checksumUrl,
    releaseUrl: typeof payload.html_url === 'string' ? payload.html_url : '',
  };
}

function validateReleaseUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('AssetHive release asset is missing a download URL');
  }
  const url = new URL(value);
  const expectedPrefix = `/${ASSETHIVE_REPOSITORY}/releases/download/`.toLowerCase();
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || !url.pathname.toLowerCase().startsWith(expectedPrefix)) {
    throw new Error('AssetHive release asset URL is not trusted');
  }
  return url.toString();
}

export function getExpectedAssetHiveExecutable(programFilesRoot: string): string {
  return path.resolve(programFilesRoot, ASSETHIVE_PRODUCT_NAME, 'AssetHive.exe');
}

export function isTrustedAssetHivePath(candidate: string, programFilesRoot: string): boolean {
  if (!candidate || !programFilesRoot) return false;
  const expected = getExpectedAssetHiveExecutable(programFilesRoot);
  return path.resolve(candidate).toLowerCase() === expected.toLowerCase();
}

export function getRegisteredAssetHiveExecutable(installLocation: unknown, displayIcon: unknown): string | null {
  const location = typeof installLocation === 'string' ? installLocation.trim() : '';
  const icon = typeof displayIcon === 'string' ? displayIcon.trim().replace(/,\s*-?\d+$/, '').replace(/^"(.*)"$/, '$1') : '';
  const candidate = location ? path.win32.join(location, 'AssetHive.exe') : icon;
  if (!/^[a-z]:\\/i.test(candidate) || path.win32.basename(candidate).toLowerCase() !== 'assethive.exe') {
    return null;
  }
  return path.win32.normalize(candidate);
}

export function parseChecksumFile(content: string, expectedFileName: string): string {
  const escapedName = expectedFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.trim().match(new RegExp(`^([a-fA-F0-9]{64})\\s+\\*?${escapedName}$`));
  if (!match) {
    throw new Error('Invalid AssetHive checksum file');
  }
  return match[1].toLowerCase();
}

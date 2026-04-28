import fs from 'fs';
import path from 'path';
import { app, BrowserWindow } from 'electron';
import { spawn, execSync, type ChildProcess } from 'child_process';
import extract from 'extract-zip';
import type {
  LauncherState,
  InstalledBuild,
  BuildInfo,
  GameVariant,
  DownloadProgress,
} from '../../types/launcher';
import { GAME_VARIANTS } from '../../types/launcher';
import type { MinioConfig, LauncherConfig } from '../../types/config';
import * as minio from './minio-client';
import { mcMirror, mcListObjects } from './mc-downloader';

const APP_NAME = 'BlackBlade Hub';
const STATE_FILE = 'launcher-state.json';
const activePids: Map<GameVariant, { pid: number; exePath: string }> = new Map();

function getStatePath(): string {
  const appData =
    process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
  return path.join(appData, APP_NAME, STATE_FILE);
}

export function loadState(): LauncherState {
  let state: LauncherState = { installBaseDir: '', installed: {} };
  try {
    const p = getStatePath();
    if (fs.existsSync(p)) state = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    // ignore parse errors
  }

  // Validate each installed entry: if the install directory no longer exists
  // on disk (e.g. manually deleted), remove the stale record and persist.
  let dirty = false;
  for (const variant of Object.keys(state.installed) as (keyof typeof state.installed)[]) {
    const entry = state.installed[variant];
    if (entry && !fs.existsSync(entry.installDir)) {
      delete state.installed[variant];
      dirty = true;
    }
  }
  if (dirty) saveState(state);

  return state;
}

export function saveState(state: LauncherState): void {
  const p = getStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf-8');
}

function emitProgress(win: BrowserWindow | null, progress: DownloadProgress): void {
  win?.webContents.send('launcher-progress', progress);
}

function emitLog(
  win: BrowserWindow | null,
  type: 'stdout' | 'stderr' | 'info' | 'error',
  msg: string,
): void {
  win?.webContents.send('script-log', { type, msg });
}

function buildLocalFileSizeMap(installDir: string): Map<string, number> {
  const localMap = new Map<string, number>();
  for (const file of listLocalFiles(installDir)) {
    const rel = path.relative(installDir, file).replace(/\\/g, '/').toLowerCase();
    try {
      localMap.set(rel, fs.statSync(file).size);
    } catch {
      // ignore files that disappear while scanning
    }
  }
  return localMap;
}

function normalizeObjectRelativePath(objectKey: string, remotePrefix: string): string {
  const normalizedKey = objectKey.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalizedPrefix = remotePrefix.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '') + '/';
  const prefixIndex = normalizedKey.indexOf(normalizedPrefix);
  if (prefixIndex >= 0) {
    return normalizedKey.slice(prefixIndex + normalizedPrefix.length);
  }
  return normalizedKey;
}

export function buildSyncPlan(
  remoteObjects: Array<{ key: string; size: number }>,
  installDir: string,
  remotePrefix: string,
): Array<{ relativePath: string; size: number; initialSize?: number }> {
  const localMap = buildLocalFileSizeMap(installDir);
  return remoteObjects
    .map((obj) => {
      const relativePath = normalizeObjectRelativePath(obj.key, remotePrefix);
      const normalizedRel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
      const initialSize = localMap.get(normalizedRel.toLowerCase());
      return {
        relativePath: normalizedRel,
        size: obj.size,
        initialSize,
      };
    })
    .filter((file) => file.relativePath && file.initialSize !== file.size);
}

function getBuildLabel(build: BuildInfo): string {
  const parts = build.objectKey.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? '';
}

function compareBuilds(a: BuildInfo, b: BuildInfo): number {
  const versionCompare = b.version.localeCompare(a.version, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (versionCompare !== 0) return versionCompare;

  const buildCompare = b.buildNumber.localeCompare(a.buildNumber, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (buildCompare !== 0) return buildCompare;

  const aHasVPrefix = /^v/i.test(getBuildLabel(a));
  const bHasVPrefix = /^v/i.test(getBuildLabel(b));
  if (aHasVPrefix !== bHasVPrefix) return bHasVPrefix ? 1 : -1;

  return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
}

export function selectLatestBuild(builds: BuildInfo[], variant: GameVariant): BuildInfo | null {
  return builds
    .filter((b) => b.variant === variant)
    .sort(compareBuilds)[0] ?? null;
}

export function selectBuild(
  builds: BuildInfo[],
  variant: GameVariant,
  objectKey?: string,
): BuildInfo | null {
  if (objectKey) {
    const selected = builds.find((b) => b.variant === variant && b.objectKey === objectKey);
    if (selected) return selected;
  }
  return selectLatestBuild(builds, variant);
}

// ---------------------------------------------------------------------------
// Auto-detect .exe inside install directory
// ---------------------------------------------------------------------------

function findExeInDirectory(dir: string): string | null {
  let rootExe: string | null = null;
  let binariesExe: string | null = null;
  const allExes: string[] = [];

  function walk(d: string, depth: number): void {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name.toLowerCase().endsWith('.exe')) {
        const rel = path.relative(dir, full);
        const parts = rel.split(path.sep);
        if (depth === 0 && parts.length === 1) {
          rootExe = full;
        } else if (/^Binaries[/\\]Win64[/\\]/i.test(rel)) {
          binariesExe = full;
        } else {
          allExes.push(full);
        }
      }
    }
  }
  walk(dir, 0);

  if (rootExe) return rootExe;
  if (binariesExe) return binariesExe;
  if (allExes.length === 0) return null;
  allExes.sort((a, b) => {
    try {
      return fs.statSync(b).size - fs.statSync(a).size;
    } catch {
      return 0;
    }
  });
  return allExes[0];
}

// ---------------------------------------------------------------------------
// Install: directory-based (mc mirror)
// ---------------------------------------------------------------------------

async function installDirectoryBuild(
  build: BuildInfo,
  minioConfig: MinioConfig,
  bucket: string,
  installDir: string,
  win: BrowserWindow | null,
): Promise<void> {
  const { variant, objectKey: prefix } = build;
  const totalSize = build.size;

  emitLog(win, 'info', `[launcher] 开始快速同步 ${variant}: ${prefix}`);
  emitProgress(win, {
    variant,
    phase: 'downloading',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: totalSize > 0 ? totalSize : undefined,
    downloadedFiles: 0,
    message: '正在下载...',
  });

  await mcMirror(minioConfig, bucket, prefix, installDir, variant, (p) => {
    if (p.phase === 'downloading') {
      let percent = p.percent;
      if (totalSize > 0 && p.downloadedBytes) {
        percent = Math.min(99, Math.floor((p.downloadedBytes / totalSize) * 100));
      } else if (p.downloadedBytes && p.downloadedBytes > 0) {
        percent = -1;
      }
      emitProgress(win, {
        ...p,
        downloadedBytes: p.downloadedBytes,
        totalBytes: totalSize > 0 ? totalSize : undefined,
        downloadedFiles: p.downloadedFiles,
        totalFiles: p.totalFiles,
        percent,
        message: p.message || (p.downloadedBytes ? formatBytes(p.downloadedBytes) + ' 已下载' : '下载中'),
      });
    } else {
      emitProgress(win, p);
    }
  }, {
    totalBytes: totalSize,
    onLog: (type, msg) => emitLog(win, type, msg),
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// ---------------------------------------------------------------------------
// Install: zip-based (single file download + extract)
// ---------------------------------------------------------------------------

async function installZipBuild(
  build: BuildInfo,
  minioConfig: MinioConfig,
  installDir: string,
  win: BrowserWindow | null,
): Promise<void> {
  const { variant, objectKey } = build;
  const tempZip = path.join(app.getPath('temp'), `bb-${variant}-${Date.now()}.zip`);

  try {
    const totalSize = build.size;
    const stream = await minio.getObjectStream(minioConfig, objectKey);
    const fileStream = fs.createWriteStream(tempZip);

    let downloaded = 0;
    let lastEmit = 0;
    const startTime = Date.now();

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        const now = Date.now();
        if (now - lastEmit > 300) {
          const elapsed = (now - startTime) / 1000;
          emitProgress(win, {
            variant,
            phase: 'downloading',
            percent: totalSize > 0 ? Math.floor((downloaded / totalSize) * 100) : 0,
            downloadedBytes: downloaded,
            totalBytes: totalSize,
            speed: elapsed > 0 ? downloaded / elapsed : 0,
          });
          lastEmit = now;
        }
      });
      stream.pipe(fileStream);
      fileStream.on('finish', resolve);
      stream.on('error', reject);
      fileStream.on('error', reject);
    });

    emitProgress(win, {
      variant,
      phase: 'downloading',
      percent: 100,
      downloadedBytes: totalSize,
      totalBytes: totalSize,
    });

    emitProgress(win, { variant, phase: 'extracting', percent: 50, message: '正在解压...' });

    if (fs.existsSync(installDir)) {
      fs.rmSync(installDir, { recursive: true, force: true });
    }
    fs.mkdirSync(installDir, { recursive: true });

    await extract(tempZip, { dir: installDir });

    emitProgress(win, { variant, phase: 'extracting', percent: 100, message: '解压完成' });
  } finally {
    try {
      if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function installBuild(
  build: BuildInfo,
  minioConfig: MinioConfig,
  launcherConfig: LauncherConfig,
  win: BrowserWindow | null,
): Promise<InstalledBuild> {
  const { variant } = build;
  const installDir = path.join(launcherConfig.installDir, variant);

  const versionFilePath = getLocalVersionPath(launcherConfig.installDir, variant);
  let oldVersionContent: string | null = null;
  try {
    if (fs.existsSync(versionFilePath)) {
      oldVersionContent = fs.readFileSync(versionFilePath, 'utf-8');
    }
  } catch { /* ignore */ }
  try { fs.unlinkSync(versionFilePath); } catch { /* ignore */ }

  try {
    if (build.isDirectory) {
      await installDirectoryBuild(build, minioConfig, minioConfig.bucket, installDir, win);
    } else {
      await installZipBuild(build, minioConfig, installDir, win);
    }

    // Verify install directory is non-empty (catches silent mc failures)
    const installedFiles = fs.existsSync(installDir)
      ? fs.readdirSync(installDir)
      : [];
    if (installedFiles.length === 0) {
      throw new Error('安装目录为空，下载可能未完成或出错');
    }

    const remoteVersionContent = await getRemoteVersionContent(minioConfig, build);
    if (remoteVersionContent !== null) {
      fs.writeFileSync(versionFilePath, remoteVersionContent, 'utf-8');
    } else {
      try { fs.unlinkSync(versionFilePath); } catch { /* ignore */ }
    }

    // Resolve exe path
    let exePath: string;
    if (build.exeRelativePath) {
      exePath = path.join(installDir, build.exeRelativePath);
    } else {
      const detected = findExeInDirectory(installDir);
      exePath = detected || path.join(installDir, 'Game.exe');
    }
    console.log('[launcher] detected exe:', exePath, 'exists:', fs.existsSync(exePath));

    const installed: InstalledBuild = {
      version: build.version,
      buildNumber: build.buildNumber,
      variant,
      installedAt: new Date().toISOString(),
      exePath,
      installDir,
      size: build.size,
    };

    const state = loadState();
    state.installBaseDir = launcherConfig.installDir;
    state.installed[variant] = installed;
    saveState(state);

    emitProgress(win, { variant, phase: 'done', percent: 100, message: '安装完成' });
    return installed;
  } catch (err) {
    if (oldVersionContent !== null) {
      try { fs.writeFileSync(versionFilePath, oldVersionContent, 'utf-8'); } catch { /* ignore */ }
    }
    const msg = err instanceof Error ? err.message : String(err);
    emitProgress(win, { variant, phase: 'error', percent: 0, message: msg });
    throw err;
  }
}

export function uninstallBuild(variant: GameVariant): void {
  const state = loadState();
  const installed = state.installed[variant];
  if (installed?.installDir && fs.existsSync(installed.installDir)) {
    fs.rmSync(installed.installDir, { recursive: true, force: true });
  }
  delete state.installed[variant];
  saveState(state);
}

export function launchBuild(variant: GameVariant): number {
  const state = loadState();
  const installed = state.installed[variant];
  if (!installed) throw new Error('游戏未安装');
  if (!fs.existsSync(installed.installDir))
    throw new Error('安装目录不存在: ' + installed.installDir);

  let exeToLaunch = installed.exePath;
  const preferRoot = path.join(installed.installDir, 'SEFVGame.exe');
  if (fs.existsSync(preferRoot)) {
    exeToLaunch = preferRoot;
    if (installed.exePath !== exeToLaunch) {
      installed.exePath = exeToLaunch;
      saveState(state);
    }
  }
  if (!fs.existsSync(exeToLaunch))
    throw new Error('可执行文件不存在: ' + exeToLaunch);

  console.log('[launcher] launching:', exeToLaunch, 'cwd:', installed.installDir);

  const child = spawn(exeToLaunch, [], {
    cwd: installed.installDir,
    detached: true,
    stdio: 'ignore',
    shell: false,
  });

  child.on('error', (err) => {
    console.error('[launcher] spawn error:', err.message);
    activePids.delete(variant);
  });

  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.warn('[launcher] process exited with code:', code, 'signal:', signal);
    }
    activePids.delete(variant);
  });

  child.unref();
  const pid = child.pid ?? 0;
  activePids.set(variant, { pid, exePath: exeToLaunch });
  return pid;
}

export function checkRunning(variant: GameVariant): boolean {
  const entry = activePids.get(variant);
  if (!entry) return false;
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch {
    activePids.delete(variant);
    return false;
  }
}

export function stopBuild(variant: GameVariant): boolean {
  const entry = activePids.get(variant);
  if (!entry) return false;
  try {
    execSync(`taskkill /T /F /PID ${entry.pid}`, { windowsHide: true, timeout: 5000 });
    activePids.delete(variant);
    return true;
  } catch {
    try {
      process.kill(entry.pid, 0);
      activePids.delete(variant);
      return false;
    } catch {
      activePids.delete(variant);
      return true;
    }
  }
}

// ---------------------------------------------------------------------------
// Version check helpers (version.txt)
// ---------------------------------------------------------------------------

export function getLocalVersion(installDir: string, variant: GameVariant): string | null {
  const versionFile = path.join(installDir, variant, 'version.txt');
  try {
    if (fs.existsSync(versionFile)) {
      const content = fs.readFileSync(versionFile, 'utf-8').trim();
      const line = content.split('\n')[0];
      const eqIndex = line.indexOf('=');
      return eqIndex >= 0 ? line.slice(eqIndex + 1).trim() : line.trim();
    }
  } catch {
    // ignore read errors
  }
  return null;
}

function getLocalVersionPath(installDir: string, variant: GameVariant): string {
  return path.join(installDir, variant, 'version.txt');
}

export async function getRemoteVersionContent(
  minioConfig: MinioConfig,
  build: BuildInfo,
): Promise<string | null> {
  const versionKey = build.objectKey.replace(/\/+$/, '') + '/version.txt';
  try {
    const stream = await minio.getObjectStream(minioConfig, versionKey);
    return new Promise<string | null>((resolve) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
      stream.on('error', () => resolve(null));
    });
  } catch {
    return null;
  }
}

export async function getRemoteVersion(
  minioConfig: MinioConfig,
  build: BuildInfo,
): Promise<string | null> {
  const versionKey = build.objectKey.replace(/\/+$/, '') + '/version.txt';
  try {
    const stream = await minio.getObjectStream(minioConfig, versionKey);
    return new Promise<string | null>((resolve) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => {
        const content = Buffer.concat(chunks).toString('utf-8').trim();
        const line = content.split('\n')[0];
        const eqIndex = line.indexOf('=');
        resolve(eqIndex >= 0 ? line.slice(eqIndex + 1).trim() : line.trim());
      });
      stream.on('error', () => resolve(null));
    });
  } catch {
    return null;
  }
}

export interface VersionCheckResult {
  variant: GameVariant;
  installed: boolean;
  localVersion: string | null;
  remoteVersion: string | null;
  needsSync: boolean;
  latestBuild: BuildInfo | null;
}

export async function checkForUpdates(
  minioConfig: MinioConfig,
  launcherConfig: LauncherConfig,
  selected?: { variant: GameVariant; objectKey?: string },
): Promise<VersionCheckResult[]> {
  const manifest = await minio.getBuilds(
    minioConfig,
    launcherConfig.prefix,
    launcherConfig.exeRelativePath || '',
  );

  console.log('[checkForUpdates] manifest builds:', manifest.builds.length);
  for (const b of manifest.builds) {
    console.log('[checkForUpdates]   build:', b.variant, b.version, 'objectKey:', b.objectKey);
  }

  const state = loadState();
  const results: VersionCheckResult[] = [];

  for (const variant of GAME_VARIANTS) {
    const installed = state.installed[variant];
    const localVersion = installed ? getLocalVersion(launcherConfig.installDir, variant) : null;

    const latestBuild = selected?.variant === variant
      ? selectBuild(manifest.builds, variant, selected.objectKey)
      : selectLatestBuild(manifest.builds, variant);

    let remoteVersion: string | null = null;
    let needsSync = false;

    if (latestBuild) {
      console.log('[checkForUpdates] checking variant:', variant, 'latestBuild objectKey:', latestBuild.objectKey);
      remoteVersion = await getRemoteVersion(minioConfig, latestBuild);
      console.log('[checkForUpdates] remoteVersion:', remoteVersion, 'localVersion:', localVersion);

      if (!installed) {
        needsSync = true;
      } else if (localVersion === null) {
        needsSync = true;
      } else if (remoteVersion !== null && localVersion !== remoteVersion) {
        needsSync = true;
      } else if (remoteVersion === null) {
        const dirVersionDiffers = installed.version !== latestBuild.version
          || installed.buildNumber !== latestBuild.buildNumber;
        if (dirVersionDiffers) {
          needsSync = true;
        }
      }
    } else {
      console.log('[checkForUpdates] no latestBuild for variant:', variant);
    }

    results.push({
      variant,
      installed: !!installed,
      localVersion,
      remoteVersion,
      needsSync,
      latestBuild,
    });
  }

  return results;
}

export interface ForceCheckResult {
  variant: GameVariant;
  installed: boolean;
  remoteFileCount: number;
  localFileCount: number;
  missingFiles: number;
  sizeMismatchFiles: number;
  remoteVersion: string | null;
  localVersion: string | null;
  needsSync: boolean;
  latestBuild: BuildInfo | null;
}

export async function forceCheckUpdates(
  minioConfig: MinioConfig,
  launcherConfig: LauncherConfig,
  selected?: { variant: GameVariant; objectKey?: string },
): Promise<ForceCheckResult[]> {
  const manifest = await minio.getBuilds(
    minioConfig,
    launcherConfig.prefix,
    launcherConfig.exeRelativePath || '',
  );

  const state = loadState();
  const results: ForceCheckResult[] = [];

  for (const variant of GAME_VARIANTS) {
    const installed = state.installed[variant];
    const localVersion = installed ? getLocalVersion(launcherConfig.installDir, variant) : null;

    const latestBuild = selected?.variant === variant
      ? selectBuild(manifest.builds, variant, selected.objectKey)
      : selectLatestBuild(manifest.builds, variant);

    let remoteVersion: string | null = null;
    let needsSync = false;
    let remoteFileCount = 0;
    let localFileCount = 0;
    let missingFiles = 0;
    let sizeMismatchFiles = 0;

    if (latestBuild) {
      remoteVersion = await getRemoteVersion(minioConfig, latestBuild);
      console.log('[forceCheckUpdates] checking:', variant, 'objectKey:', latestBuild.objectKey);

      if (!installed) {
        needsSync = true;
      } else {
        const prefix = latestBuild.objectKey.replace(/\/+$/, '') + '/';
        const remoteObjects = await mcListObjects(minioConfig, minioConfig.bucket, prefix);
        remoteFileCount = remoteObjects.length;

        const installDir = path.join(launcherConfig.installDir, variant);
        const localFiles = listLocalFiles(installDir);
        localFileCount = localFiles.length;

        const syncPlan = buildSyncPlan(remoteObjects, installDir, prefix);
        for (const file of syncPlan) {
          if (file.initialSize === undefined) {
            missingFiles++;
          } else {
            sizeMismatchFiles++;
          }
        }
        console.log(
          '[forceCheckUpdates] result:',
          variant,
          'remoteFileCount:', remoteFileCount,
          'localFileCount:', localFileCount,
          'missingFiles:', missingFiles,
          'sizeMismatchFiles:', sizeMismatchFiles,
        );

        if (missingFiles > 0 || sizeMismatchFiles > 0) {
          needsSync = true;
        } else if (localVersion === null) {
          needsSync = true;
        } else if (remoteVersion !== null && localVersion !== remoteVersion) {
          needsSync = true;
        } else if (remoteVersion === null) {
          const dirVersionDiffers = installed.version !== latestBuild.version
            || installed.buildNumber !== latestBuild.buildNumber;
          if (dirVersionDiffers) {
            needsSync = true;
          }
        }
      }
    }

    results.push({
      variant,
      installed: !!installed,
      remoteFileCount,
      localFileCount,
      missingFiles,
      sizeMismatchFiles,
      remoteVersion,
      localVersion,
      needsSync,
      latestBuild,
    });
  }

  return results;
}

function listLocalFiles(dir: string): string[] {
  const result: string[] = [];
  function walk(d: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        result.push(full);
      }
    }
  }
  walk(dir);
  return result;
}

export async function syncBuild(
  build: BuildInfo,
  minioConfig: MinioConfig,
  launcherConfig: LauncherConfig,
  win: BrowserWindow | null,
): Promise<InstalledBuild> {
  return installBuild(build, minioConfig, launcherConfig, win);
}

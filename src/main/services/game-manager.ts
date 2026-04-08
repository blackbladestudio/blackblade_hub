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
import type { MinioConfig, LauncherConfig } from '../../types/config';
import * as minio from './minio-client';
import { mcMirror } from './mc-downloader';

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

  emitProgress(win, { variant, phase: 'downloading', percent: 0, message: '正在下载...' });

  await mcMirror(minioConfig, bucket, prefix, installDir, variant, (p) => {
    if (p.phase === 'downloading') {
      emitProgress(win, {
        ...p,
        downloadedBytes: p.downloadedBytes,
        totalBytes: totalSize > 0 ? totalSize : undefined,
        percent: (totalSize > 0 && p.downloadedBytes)
          ? Math.min(99, Math.floor((p.downloadedBytes / totalSize) * 100))
          : 0,
        message: p.message || (p.downloadedBytes ? formatBytes(p.downloadedBytes) + ' 已下载' : '下载中'),
      });
    } else {
      emitProgress(win, p);
    }
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

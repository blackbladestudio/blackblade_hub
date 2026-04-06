import fs from 'fs';
import path from 'path';
import { app, BrowserWindow } from 'electron';
import { spawn } from 'child_process';
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
  const exeFiles: string[] = [];
  function walk(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.toLowerCase().endsWith('.exe')) {
        exeFiles.push(full);
      }
    }
  }
  walk(dir);

  // Prefer .exe in a Binaries directory (Unreal convention)
  const inBinaries = exeFiles.find((f) => /[/\\]Binaries[/\\]/i.test(f));
  if (inBinaries) return inBinaries;
  // Otherwise, prefer the largest .exe (likely the game itself, not small tools)
  if (exeFiles.length === 0) return null;
  exeFiles.sort((a, b) => {
    try {
      return fs.statSync(b).size - fs.statSync(a).size;
    } catch {
      return 0;
    }
  });
  return exeFiles[0];
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

  emitProgress(win, { variant, phase: 'downloading', percent: 0, message: '正在下载...' });

  await mcMirror(minioConfig, bucket, prefix, installDir, variant, (p) => {
    emitProgress(win, p);
  });
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

export function launchBuild(variant: GameVariant): void {
  const state = loadState();
  const installed = state.installed[variant];
  if (!installed) throw new Error('游戏未安装');
  if (!fs.existsSync(installed.installDir))
    throw new Error('安装目录不存在: ' + installed.installDir);
  if (!fs.existsSync(installed.exePath))
    throw new Error('可执行文件不存在: ' + installed.exePath);

  const child = spawn(installed.exePath, [], {
    cwd: path.dirname(installed.exePath),
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  child.unref();
}

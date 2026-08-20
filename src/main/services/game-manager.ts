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
import { mcMirror, mcListObjects, setActiveStream, type McListObject } from './mc-downloader';

const APP_NAME = 'BlackBlade Hub';
const STATE_FILE = 'launcher-state.json';
const LARGE_FILE_THRESHOLD = 500 * 1024 * 1024; // 500MB
/** 文件系统时间精度差异的容忍量，避免因秒级取整误判为过期 */
const MTIME_TOLERANCE_MS = 2000;
const DOWNLOAD_TMP_SUFFIX = '.downloading';
const DOWNLOAD_META_SUFFIX = '.downloading.meta';
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
  // If the default variant is no longer installed, clear the stale default.
  if (state.defaultVariant && !state.installed[state.defaultVariant]) {
    delete state.defaultVariant;
    dirty = true;
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

interface LocalFileStat {
  size: number;
  mtimeMs: number;
}

// 传入 files 可复用已有的目录遍历结果，避免同一次流程里重复走盘
function buildLocalStatMap(installDir: string, files?: string[]): Map<string, LocalFileStat> {
  const localMap = new Map<string, LocalFileStat>();
  for (const file of files ?? listLocalFiles(installDir)) {
    const rel = path.relative(installDir, file).replace(/\\/g, '/').toLowerCase();
    try {
      const stat = fs.statSync(file);
      localMap.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // ignore files that disappear while scanning
    }
  }
  return localMap;
}

/**
 * 本地文件是否比远端旧。用于大文件——它们被排除在 mc mirror 之外，
 * 没有 mirror 的 mtime 比对兜底，需要在这里自行判断内容是否已变化。
 * 无法取得可靠时间时一律返回 false，避免误触发整包重传。
 */
function isLocalOlderThanRemote(localMtimeMs?: number, remoteLastModified?: string): boolean {
  if (localMtimeMs === undefined || !remoteLastModified) return false;
  const remoteMs = Date.parse(remoteLastModified);
  if (Number.isNaN(remoteMs)) return false;
  return localMtimeMs + MTIME_TOLERANCE_MS < remoteMs;
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

export interface SyncPlanEntry {
  relativePath: string;
  size: number;
  initialSize?: number;
  initialMtimeMs?: number;
  lastModified?: string;
}

export function buildSyncPlan(
  remoteObjects: Array<{ key: string; size: number; lastModified?: string }>,
  installDir: string,
  remotePrefix: string,
  precomputedLocalMap?: Map<string, LocalFileStat>,
): SyncPlanEntry[] {
  const localMap = precomputedLocalMap ?? buildLocalStatMap(installDir);
  return remoteObjects
    .map((obj) => {
      const relativePath = normalizeObjectRelativePath(obj.key, remotePrefix);
      const normalizedRel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
      const local = localMap.get(normalizedRel.toLowerCase());
      return {
        relativePath: normalizedRel,
        size: obj.size,
        initialSize: local?.size,
        initialMtimeMs: local?.mtimeMs,
        lastModified: obj.lastModified,
      };
    })
    .filter((file) => {
      if (!file.relativePath) return false;
      if (file.initialSize !== file.size) return true;
      // 大小一致的小文件交给 mc mirror 判断；大文件不经过 mirror，这里补上时间比对
      if (file.size >= LARGE_FILE_THRESHOLD) {
        return isLocalOlderThanRemote(file.initialMtimeMs, file.lastModified);
      }
      return false;
    });
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

/** 返回本次使用的远端对象清单，供后续校验阶段复用，避免重复全量列举 */
async function installDirectoryBuild(
  build: BuildInfo,
  minioConfig: MinioConfig,
  bucket: string,
  installDir: string,
  win: BrowserWindow | null,
  excludePatterns?: string[],
): Promise<McListObject[]> {
  const { variant, objectKey: prefix } = build;

  emitLog(win, 'info', `[launcher] 开始快速同步 ${variant}: ${prefix}`);
  emitProgress(win, {
    variant,
    phase: 'downloading',
    percent: 0,
    downloadedBytes: 0,
    message: '正在获取文件列表...',
  });

  const remoteObjects = await mcListObjects(minioConfig, bucket, prefix, {
    onLog: (type, msg) => emitLog(win, type, msg),
  });
  const totalSize = remoteObjects.reduce((sum, obj) => sum + obj.size, 0);
  const totalFiles = remoteObjects.length;

  // 本地目录只遍历一次，同步计划与多余文件清理共用同一份结果
  const localFiles = listLocalFiles(installDir);
  const localStatMap = buildLocalStatMap(installDir, localFiles);

  const syncPlan = buildSyncPlan(remoteObjects, installDir, prefix, localStatMap);
  const needSyncBytes = syncPlan.reduce((sum, f) => sum + f.size, 0);

  emitLog(win, 'info', `[launcher] 远端 ${totalFiles} 个文件，共 ${formatBytes(totalSize)}；需同步 ${syncPlan.length} 个文件，${formatBytes(needSyncBytes)}`);

  const removed = cleanupExtraFiles(remoteObjects, installDir, prefix, excludePatterns, localFiles);
  if (removed > 0) {
    emitLog(win, 'info', `[launcher] 清理了 ${removed} 个多余本地文件`);
  }

  const largeFiles = syncPlan.filter((f) => f.size >= LARGE_FILE_THRESHOLD);
  const smallFiles = syncPlan.filter((f) => f.size < LARGE_FILE_THRESHOLD);
  const plannedTotal = needSyncBytes > 0 ? needSyncBytes : totalSize;
  const plannedFiles = syncPlan.length > 0 ? syncPlan.length : totalFiles;

  let downloadedSoFar = 0;
  let filesDoneSoFar = 0;
  let lastProgressTime = Date.now();
  let lastProgressBytes = 0;
  let currentSpeed = 0;
  const speedSamples: Array<{ time: number; bytes: number }> = [];

  const emitOverallProgress = (currentFileBytes: number): void => {
    const totalDl = downloadedSoFar + currentFileBytes;
    const now = Date.now();
    speedSamples.push({ time: now, bytes: totalDl });
    while (speedSamples.length > 0 && now - speedSamples[0].time > 5000) {
      speedSamples.shift();
    }
    if (speedSamples.length >= 2) {
      const oldest = speedSamples[0];
      const elapsed = (now - oldest.time) / 1000;
      if (elapsed > 0) currentSpeed = Math.max(0, (totalDl - oldest.bytes) / elapsed);
    }
    const percent = plannedTotal > 0 ? Math.min(99, Math.floor((totalDl / plannedTotal) * 100)) : 0;
    emitProgress(win, {
      variant,
      phase: 'downloading',
      percent,
      downloadedBytes: totalDl,
      totalBytes: plannedTotal > 0 ? plannedTotal : undefined,
      downloadedFiles: filesDoneSoFar,
      totalFiles: plannedFiles > 0 ? plannedFiles : undefined,
      speed: currentSpeed > 0 ? currentSpeed : undefined,
    });
  };

  emitOverallProgress(0);

  if (largeFiles.length > 0) {
    emitLog(win, 'info', `[launcher] ${largeFiles.length} 个大文件 (>500MB) 使用流式下载`);
    for (const file of largeFiles) {
      const objectKey = prefix.replace(/\/+$/, '') + '/' + file.relativePath;
      const targetPath = path.join(installDir, file.relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      emitLog(win, 'info', `[launcher] 流式下载: ${file.relativePath} (${formatBytes(file.size)})`);

      await streamDownloadFile(minioConfig, objectKey, targetPath, file.size, (bytes) => {
        emitOverallProgress(bytes);
      }, file.lastModified);

      downloadedSoFar += file.size;
      filesDoneSoFar++;
      emitOverallProgress(0);
    }
  }

  // 所有大文件都由上面的流式下载负责，一律不交给 mc mirror。
  // 只排除「本次需同步」的大文件会导致已是最新的大文件落到 mirror 手里，
  // 而它们的 mtime 是本地写盘时间，mirror 会判定远端更新从而整包重传。
  const largeExcludes = remoteObjects
    .filter((obj) => obj.size >= LARGE_FILE_THRESHOLD)
    .map((obj) => normalizeObjectRelativePath(obj.key, prefix))
    .filter((rel) => rel.length > 0);
  const allExcludes = [...(excludePatterns ?? []), ...largeExcludes];

  const smallSyncBytes = smallFiles.reduce((sum, f) => sum + f.size, 0);

  if (smallSyncBytes > 0 || largeFiles.length === 0) {
    await mcMirror(minioConfig, bucket, prefix, installDir, variant, (p) => {
      if (p.phase === 'downloading') {
        const mcBytes = p.downloadedBytes ?? 0;
        const totalDl = downloadedSoFar + mcBytes;
        const percent = plannedTotal > 0 ? Math.min(99, Math.floor((totalDl / plannedTotal) * 100)) : 0;
        emitProgress(win, {
          ...p,
          downloadedBytes: totalDl,
          totalBytes: plannedTotal > 0 ? plannedTotal : undefined,
          downloadedFiles: filesDoneSoFar + (p.downloadedFiles ?? 0),
          totalFiles: plannedFiles > 0 ? plannedFiles : undefined,
          percent,
        });
      } else {
        emitProgress(win, p);
      }
    }, {
      totalBytes: smallSyncBytes > 0 ? smallSyncBytes : plannedTotal,
      totalFiles: smallFiles.length > 0 ? smallFiles.length : plannedFiles,
      trackedFiles: smallFiles.length > 0 ? smallFiles : undefined,
      onLog: (type, msg) => emitLog(win, type, msg),
      excludePatterns: allExcludes.length > 0 ? allExcludes : undefined,
    });
  }

  return remoteObjects;
}

interface DownloadMeta {
  objectKey: string;
  size: number;
  lastModified: string;
}

/**
 * 残留的分片是否确属同一个远端对象。
 * 缺少 meta（老版本留下的分片）一律视为不可续传：无法确认来源时
 * 续传会把两个版本的内容拼接成一个大小正确但内容损坏的文件。
 */
function canResumeDownload(metaPath: string, expected: DownloadMeta): boolean {
  try {
    const saved = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Partial<DownloadMeta>;
    return saved.objectKey === expected.objectKey
      && saved.size === expected.size
      && saved.lastModified === expected.lastModified;
  } catch {
    return false;
  }
}

/** 把本地 mtime 对齐到远端对象时间，使后续增量判断与 mc 的语义一致 */
function applyRemoteMtime(filePath: string, lastModified?: string): void {
  if (!lastModified) return;
  const ts = Date.parse(lastModified);
  if (Number.isNaN(ts)) return;
  try {
    const d = new Date(ts);
    fs.utimesSync(filePath, d, d);
  } catch {
    // 设置失败只会让下次多比对一次，不影响文件内容
  }
}

async function streamDownloadFile(
  minioConfig: MinioConfig,
  objectKey: string,
  targetPath: string,
  totalSize: number,
  onProgress: (downloadedBytes: number) => void,
  remoteLastModified?: string,
): Promise<void> {
  const tmpPath = targetPath + DOWNLOAD_TMP_SUFFIX;
  const metaPath = targetPath + DOWNLOAD_META_SUFFIX;
  const meta: DownloadMeta = {
    objectKey,
    size: totalSize,
    lastModified: remoteLastModified ?? '',
  };

  let existingBytes = 0;
  try {
    if (fs.existsSync(tmpPath)) {
      if (canResumeDownload(metaPath, meta)) {
        existingBytes = fs.statSync(tmpPath).size;
        if (existingBytes >= totalSize) {
          existingBytes = 0;
          fs.unlinkSync(tmpPath);
        }
      } else {
        existingBytes = 0;
        fs.unlinkSync(tmpPath);
      }
    }
  } catch {
    existingBytes = 0;
  }

  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');
  } catch {
    // 写不出 meta 就放弃续传能力，但不阻断本次下载
  }

  const stream = existingBytes > 0
    ? await minio.getPartialObjectStream(minioConfig, objectKey, existingBytes)
    : await minio.getObjectStream(minioConfig, objectKey);
  setActiveStream(stream);

  const fileStream = fs.createWriteStream(tmpPath, existingBytes > 0 ? { flags: 'a' } : undefined);

  let downloaded = existingBytes;
  let lastEmit = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        const now = Date.now();
        if (now - lastEmit > 500) {
          onProgress(downloaded);
          lastEmit = now;
        }
      });
      stream.on('close', () => {
        if (downloaded < totalSize) {
          fileStream.destroy();
          reject(new Error('下载已中断'));
        }
      });
      stream.pipe(fileStream);
      fileStream.on('finish', resolve);
      stream.on('error', (err) => { fileStream.destroy(); reject(err); });
      fileStream.on('error', reject);
    });

    onProgress(totalSize);

    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
    fs.renameSync(tmpPath, targetPath);
    applyRemoteMtime(targetPath, remoteLastModified);
    try { fs.unlinkSync(metaPath); } catch { /* ignore */ }
  } finally {
    setActiveStream(null);
  }
}

/** 若路径是下载中间产物，返回其对应的目标文件相对路径；否则返回 null */
function downloadTempBasePath(relLower: string): string | null {
  if (relLower.endsWith(DOWNLOAD_META_SUFFIX)) {
    return relLower.slice(0, -DOWNLOAD_META_SUFFIX.length);
  }
  if (relLower.endsWith(DOWNLOAD_TMP_SUFFIX)) {
    return relLower.slice(0, -DOWNLOAD_TMP_SUFFIX.length);
  }
  return null;
}

function cleanupExtraFiles(
  remoteObjects: Array<{ key: string; size: number }>,
  installDir: string,
  remotePrefix: string,
  excludePatterns?: string[],
  precomputedLocalFiles?: string[],
): number {
  const remoteSet = new Set<string>();
  for (const obj of remoteObjects) {
    const rel = normalizeObjectRelativePath(obj.key, remotePrefix);
    if (rel) remoteSet.add(rel.replace(/\\/g, '/').toLowerCase());
  }

  const excludeRegexes = (excludePatterns ?? []).map((p) => {
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
  });

  let removed = 0;
  const localFiles = precomputedLocalFiles ?? listLocalFiles(installDir);
  for (const file of localFiles) {
    const rel = path.relative(installDir, file).replace(/\\/g, '/');
    const relLower = rel.toLowerCase();

    if (excludeRegexes.some((re) => re.test(rel) || re.test(relLower))) continue;

    // 未完成的分片及其 meta：目标对象仍在远端时保留以便续传；
    // 远端已经没有该对象则属于换版本后遗留的孤儿，按多余文件删除。
    const tmpBase = downloadTempBasePath(relLower);
    if (tmpBase !== null && remoteSet.has(tmpBase)) continue;

    if (!remoteSet.has(relLower)) {
      try {
        fs.unlinkSync(file);
        removed++;
      } catch {
        // ignore
      }
    }
  }

  if (removed > 0) {
    removeEmptyDirs(installDir);
  }

  return removed;
}

function removeEmptyDirs(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const full = path.join(dir, entry.name);
      removeEmptyDirs(full);
      try {
        const remaining = fs.readdirSync(full);
        if (remaining.length === 0) fs.rmdirSync(full);
      } catch {
        // ignore
      }
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// remoteObjects 由安装阶段传入，复用同一份清单，省掉一次远端全量列举
function verifyInstalledFiles(
  remoteObjects: Array<{ key: string; size: number }>,
  prefix: string,
  installDir: string,
  win: BrowserWindow | null,
  variant: GameVariant,
): { verified: number; missing: number; mismatched: number } {
  let verified = 0;
  let missing = 0;
  let mismatched = 0;
  const total = remoteObjects.length;

  for (let i = 0; i < remoteObjects.length; i++) {
    const obj = remoteObjects[i];
    const rel = normalizeObjectRelativePath(obj.key, prefix);
    if (!rel) continue;
    const localPath = path.join(installDir, rel);

    try {
      const stat = fs.statSync(localPath);
      if (stat.size === obj.size) {
        verified++;
      } else {
        mismatched++;
        emitLog(win, 'error', `[verify] 大小不一致: ${rel} (本地 ${stat.size} vs 远端 ${obj.size})`);
      }
    } catch {
      missing++;
      emitLog(win, 'error', `[verify] 文件缺失: ${rel}`);
    }

    if ((i + 1) % 100 === 0 || i === remoteObjects.length - 1) {
      const percent = Math.floor(((i + 1) / total) * 100);
      emitProgress(win, { variant, phase: 'verifying', percent, message: `正在校验 ${i + 1} / ${total} 个文件...` });
    }
  }

  emitLog(win, 'info', `[verify] 校验完成: ${verified} 正确, ${missing} 缺失, ${mismatched} 不一致`);
  return { verified, missing, mismatched };
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

  try {
    if (build.isDirectory) {
      const remoteObjects = await installDirectoryBuild(build, minioConfig, minioConfig.bucket, installDir, win, launcherConfig.excludePatterns);

      emitProgress(win, { variant, phase: 'verifying', percent: 0, message: '正在校验文件...' });
      const verifyResult = verifyInstalledFiles(remoteObjects, build.objectKey, installDir, win, variant);
      if (verifyResult.mismatched > 0) {
        throw new Error(`校验失败: ${verifyResult.mismatched} 个文件大小不一致`);
      }
      if (verifyResult.missing > 0) {
        throw new Error(`校验失败: ${verifyResult.missing} 个文件缺失`);
      }
      emitProgress(win, { variant, phase: 'verifying', percent: 100, message: `校验完成，${verifyResult.verified} 个文件正确` });
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
      fs.mkdirSync(path.dirname(versionFilePath), { recursive: true });
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
  // 若卸载的是默认包体，清除默认设置
  if (state.defaultVariant === variant) {
    delete state.defaultVariant;
  }
  saveState(state);
}

/**
 * 返回主界面「启动游戏」应默认启动的包体。
 * 优先返回显式设置且仍已安装的 defaultVariant，否则回退到第一个已安装的包体。
 */
export function resolveDefaultVariant(state: LauncherState): GameVariant | null {
  if (state.defaultVariant && state.installed[state.defaultVariant]) {
    return state.defaultVariant;
  }
  return GAME_VARIANTS.find((v) => state.installed[v]) ?? null;
}

export function getDefaultVariant(): GameVariant | null {
  return resolveDefaultVariant(loadState());
}

/** 设置默认启动包体；变体必须已安装。传 null 清除设置。 */
export function setDefaultVariant(variant: GameVariant | null): void {
  const state = loadState();
  if (variant === null) {
    delete state.defaultVariant;
  } else {
    if (!state.installed[variant]) {
      throw new Error(`包体未安装，无法设为默认: ${variant}`);
    }
    state.defaultVariant = variant;
  }
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
        // 本地目录只走一次盘，文件数统计与同步计划共用
        const localStatMap = buildLocalStatMap(installDir);
        localFileCount = localStatMap.size;

        const syncPlan = buildSyncPlan(remoteObjects, installDir, prefix, localStatMap);
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

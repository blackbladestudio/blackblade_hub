import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { resolvePath } from '../utils';
import type { MinioConfig } from '../../types/config';
import type { GameVariant, DownloadProgress } from '../../types/launcher';
import type { Readable } from 'stream';

let activeMirrorProcess: ChildProcess | null = null;
let activeStream: Readable | null = null;

export function setActiveStream(stream: Readable | null): void {
  activeStream = stream;
}

export function abortMirror(): boolean {
  let aborted = false;
  if (activeStream) {
    activeStream.destroy();
    activeStream = null;
    aborted = true;
  }
  if (activeMirrorProcess && !activeMirrorProcess.killed) {
    activeMirrorProcess.kill();
    activeMirrorProcess = null;
    aborted = true;
  }
  return aborted;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

const MC_ALIAS = 'bb';

function findMcBinary(): string {
  const bundled = resolvePath('tools/mc.exe');
  if (fs.existsSync(bundled)) return bundled;

  // Fall back to mc on PATH
  return 'mc';
}

function buildEndpointUrl(config: MinioConfig): string {
  const url = new URL(config.endpoint);
  let host = url.hostname;
  if (url.port) {
    host += `:${url.port}`;
  }
  let endpoint = `${url.protocol}//${host}`;
  if (url.pathname && url.pathname !== '/') {
    endpoint += url.pathname.replace(/\/$/, '');
  }
  return endpoint;
}

async function setupAlias(mc: string, config: MinioConfig): Promise<void> {
  const endpoint = buildEndpointUrl(config);
  return new Promise((resolve, reject) => {
    const args = ['alias', 'set', MC_ALIAS, endpoint, config.accessKey, config.secretKey];
    const child = spawn(mc, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mc alias set failed: ${stderr}`));
    });
  });
}

/**
 * Download an entire S3 prefix to a local directory using `mc mirror`.
 *
 * This bypasses the minio JS SDK entirely, so the fast-xml-parser
 * entity expansion limit is irrelevant.  mc handles its own pagination,
 * concurrency, and retry logic.
 *
 * mc mirror --json emits one JSON line per file copied:
 *   { "status": "success", "source": "...", "target": "...",
 *     "size": <file_bytes>, "totalSize": <cumulative_bytes>, "totalCount": <cumulative_count> }
 * There is no upfront "total bytes" field; progress is shown as
 * cumulative bytes transferred.
 */
export async function mcMirror(
  minioConfig: MinioConfig,
  bucket: string,
  prefix: string,
  localDir: string,
  variant: GameVariant,
  onProgress: (p: DownloadProgress) => void,
  options: {
    totalBytes?: number;
    totalFiles?: number;
    trackedFiles?: Array<{ relativePath: string; size: number; initialSize?: number }>;
    onLog?: (type: 'stdout' | 'stderr' | 'info' | 'error', msg: string) => void;
    /** mc mirror --exclude patterns; matching files/folders are skipped and not deleted by --remove */
    excludePatterns?: string[];
  } = {},
): Promise<void> {
  const mc = findMcBinary();
  const maxWorkers = minioConfig.maxWorkers ?? 16;

  await setupAlias(mc, minioConfig);

  const normalizedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const remotePath = `${MC_ALIAS}/${bucket}/${normalizedPrefix}`;

  const baseSnapshot = options.trackedFiles?.length ? new Map<string, number>() : snapshotLocalFiles(localDir);
  fs.mkdirSync(localDir, { recursive: true });

  return new Promise<void>((resolve, reject) => {
    const excludeArgs = options.excludePatterns?.flatMap((p) => ['--exclude', p]) ?? [];
    const args = [
      'mirror',
      '--overwrite',
      '--json',
      '--no-color',
      '--max-workers',
      String(maxWorkers),
      '--retry',
      '--summary',
      ...excludeArgs,
      remotePath,
      localDir,
    ];
    const log = (type: 'stdout' | 'stderr' | 'info' | 'error', msg: string): void => {
      options.onLog?.(type, msg);
      if (type === 'stderr' || type === 'error') console.error(msg);
      else console.log(msg);
    };

    log('info', `[mc-mirror] running: "${mc}" ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);

    const child = spawn(mc, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeMirrorProcess = child;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let stderrText = '';
    let settled = false;
    const plannedTotalBytes = options.totalBytes ?? 0;
    const plannedTotalFiles = options.totalFiles ?? 0;
    let transferredBytes = 0;
    let transferredCount = 0;
    let lastScannedBytes = 0;
    let lastScannedFiles = 0;
    let currentSpeed = 0;
    const errorMessages: string[] = [];
    const speedSamples: Array<{ time: number; bytes: number }> = [];
    const SPEED_WINDOW_MS = 5000;

    const scanLocalProgress = (): { bytes: number; files: number } => {
      let bytes = 0;
      let files = 0;

      if (options.trackedFiles && options.trackedFiles.length > 0) {
        for (const file of options.trackedFiles) {
          const full = path.join(localDir, file.relativePath);
          let currentSize = 0;
          try {
            currentSize = fs.statSync(full).size;
          } catch {
            try {
              currentSize = fs.statSync(full + '.part.minio').size;
            } catch {
              continue;
            }
          }

          if (currentSize === file.size) {
            bytes += file.size;
            files++;
            continue;
          }

          if (file.initialSize !== undefined && currentSize === file.initialSize) {
            continue;
          }

          if (currentSize > 0 && currentSize < file.size) {
            bytes += currentSize;
          }
        }
        return { bytes, files };
      }

      const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            const rel = path.relative(localDir, full).replace(/\\/g, '/').toLowerCase();
            const initialSize = baseSnapshot.get(rel);
            try {
              const currentSize = fs.statSync(full).size;
              if (initialSize === undefined) {
                files++;
                bytes += currentSize;
              } else if (currentSize !== initialSize) {
                files++;
                bytes += Math.max(0, currentSize - Math.min(initialSize, currentSize));
              }
            } catch {
              // 文件可能正在被 mc 写入，下一轮扫描会重新统计
            }
          }
        }
      };

      walk(localDir);
      return { bytes, files };
    };

    const emitDownloadingProgress = (message?: string, forceScan = false): void => {
      if (forceScan) {
        const scanned = scanLocalProgress();
        lastScannedBytes = scanned.bytes;
        lastScannedFiles = scanned.files;
      }

      const actualBytes = Math.max(transferredBytes, lastScannedBytes);
      const actualFiles = Math.max(transferredCount, lastScannedFiles);
      const now = Date.now();
      speedSamples.push({ time: now, bytes: actualBytes });
      while (speedSamples.length > 0 && now - speedSamples[0].time > SPEED_WINDOW_MS) {
        speedSamples.shift();
      }
      if (speedSamples.length >= 2) {
        const oldest = speedSamples[0];
        const elapsed = (now - oldest.time) / 1000;
        if (elapsed > 0) {
          currentSpeed = Math.max(0, (actualBytes - oldest.bytes) / elapsed);
        }
      }

      const percent = plannedTotalBytes > 0
        ? Math.min(99, Math.floor((actualBytes / plannedTotalBytes) * 100))
        : actualBytes > 0
          ? -1
          : 0;

      onProgress({
        variant,
        phase: 'downloading',
        percent,
        downloadedBytes: actualBytes,
        totalBytes: plannedTotalBytes > 0 ? plannedTotalBytes : undefined,
        downloadedFiles: actualFiles,
        totalFiles: plannedTotalFiles > 0 ? plannedTotalFiles : undefined,
        speed: currentSpeed > 0 ? currentSpeed : undefined,
        message,
      });
    };

    const scanTimer = setInterval(() => {
      emitDownloadingProgress(undefined, true);
    }, 1000);

    const handleJsonMessage = (msg: any, line: string): void => {
      if (msg.status === 'error') {
        const message = msg.error?.cause?.message || msg.error?.message || line;
        errorMessages.push(message);
        log('error', `[mc-mirror] error: ${message}`);
        onProgress({ variant, phase: 'error', percent: 0, message });
        return;
      }

      if (msg.status === 'progress') {
        if (typeof msg.size === 'number') transferredBytes = Math.max(transferredBytes, msg.size);
        if (typeof msg.transferred === 'number') transferredBytes = Math.max(transferredBytes, msg.transferred);
        emitDownloadingProgress();
        return;
      }

      if (msg.status === 'success' || msg.type === 'file') {
        if (typeof msg.totalSize === 'number') transferredBytes = Math.max(transferredBytes, msg.totalSize);
        else if (typeof msg.accumulativeSize === 'number') transferredBytes = Math.max(transferredBytes, msg.accumulativeSize);
        else if (typeof msg.size === 'number') transferredBytes += msg.size;
        if (msg.type !== 'summary') transferredCount += 1;
        emitDownloadingProgress();
        return;
      }
    };

    const handleLine = (stream: 'stdout' | 'stderr', rawLine: string): void => {
      const line = rawLine.trim();
      if (!line) return;

      if (stream === 'stdout') {
        log('stdout', `[mc-mirror][stdout] ${line}`);
      } else {
        stderrText += line + '\n';
        log('stderr', `[mc-mirror][stderr] ${line}`);
      }

      if (!line.startsWith('{')) return;
      try {
        handleJsonMessage(JSON.parse(line), line);
      } catch (err) {
        log('stderr', `[mc-mirror] failed to parse json line: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const handleChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf-8');
      if (stream === 'stdout') {
        stdoutBuffer += text;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) handleLine('stdout', line);
      } else {
        stderrBuffer += text;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? '';
        for (const line of lines) handleLine('stderr', line);
      }
    };

    child.stdout!.on('data', (chunk: Buffer) => handleChunk('stdout', chunk));
    child.stderr!.on('data', (chunk: Buffer) => handleChunk('stderr', chunk));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      activeMirrorProcess = null;
      clearInterval(scanTimer);
      reject(new Error(`mc mirror 启动失败: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      activeMirrorProcess = null;
      clearInterval(scanTimer);

      handleLine('stdout', stdoutBuffer);
      handleLine('stderr', stderrBuffer);
      emitDownloadingProgress(undefined, true);

      log('info', `[mc-mirror] closed: code=${code}, files=${Math.max(transferredCount, lastScannedFiles)}, bytes=${Math.max(transferredBytes, lastScannedBytes)}`);

      if (code !== 0 || errorMessages.length > 0) {
        reject(new Error(errorMessages[0] || stderrText.trim() || `mc mirror 退出码: ${code}`));
        return;
      }

      onProgress({
        variant,
        phase: 'downloading',
        percent: 100,
        downloadedBytes: Math.max(transferredBytes, lastScannedBytes),
        totalBytes: plannedTotalBytes > 0 ? plannedTotalBytes : undefined,
        downloadedFiles: Math.max(transferredCount, lastScannedFiles),
        totalFiles: plannedTotalFiles > 0 ? plannedTotalFiles : undefined,
        message: `${Math.max(transferredCount, lastScannedFiles)} 个文件下载完成`,
      });
      resolve();
    });
  });
}

function snapshotLocalFiles(dir: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          snapshot.set(path.relative(dir, full).replace(/\\/g, '/').toLowerCase(), fs.statSync(full).size);
        } catch {
          // ignore
        }
      }
    }
  };
  walk(dir);
  return snapshot;
}

export interface McListObject {
  key: string;
  size: number;
  lastModified: string;
}

function normalizeRemotePrefix(prefix: string): string {
  return prefix.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '') + '/';
}

export async function mcListObjects(
  minioConfig: MinioConfig,
  bucket: string,
  prefix: string,
  options: {
    onLog?: (type: 'stdout' | 'stderr' | 'info' | 'error', msg: string) => void;
    onProgress?: (count: number, bytes: number) => void;
  } = {},
): Promise<McListObject[]> {
  const mc = findMcBinary();
  await setupAlias(mc, minioConfig);

  const normalizedPrefix = normalizeRemotePrefix(prefix);
  const remotePath = `${MC_ALIAS}/${bucket}/${normalizedPrefix}`;

  return new Promise<McListObject[]>((resolve, reject) => {
    const args = ['ls', '--json', '--no-color', '--recursive', remotePath];
    const child = spawn(mc, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    const objects: McListObject[] = [];
    let stdoutBuffer = '';
    let totalBytes = 0;
    let lastReportAt = Date.now();

    const reportProgress = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastReportAt < 1000) return;
      lastReportAt = now;
      options.onProgress?.(objects.length, totalBytes);
      options.onLog?.('info', `[mc-ls] 已扫描 ${objects.length} 个文件，累计 ${formatBytes(totalBytes)}`);
    };

    options.onLog?.('info', `[mc-ls] running: "${mc}" ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.key && (!msg.type || msg.type === 'file')) {
            const size = typeof msg.size === 'number' ? msg.size : 0;
            objects.push({
              key: String(msg.key).replace(/\\/g, '/').replace(/^\/+/, ''),
              size,
              lastModified: msg.lastModified || '',
            });
            totalBytes += size;
            reportProgress();
          }
        } catch {
          // non-JSON line, ignore
        }
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      const trimmed = text.trim();
      if (trimmed) options.onLog?.('stderr', `[mc-ls][stderr] ${trimmed}`);
    });

    child.on('error', (err) => reject(new Error(`mc ls 失败: ${err.message}`)));

    child.on('close', (code) => {
      reportProgress(true);
      if (code === 0) {
        options.onLog?.('info', `[mc-ls] 完成: ${objects.length} 个文件，${formatBytes(totalBytes)}`);
        resolve(objects);
      } else {
        reject(new Error(`mc ls 退出码: ${code}${stderr ? ' - ' + stderr.trim() : ''}`));
      }
    });
  });
}

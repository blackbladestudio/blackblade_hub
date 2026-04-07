import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { resolvePath } from '../utils';
import type { MinioConfig } from '../../types/config';
import type { GameVariant, DownloadProgress } from '../../types/launcher';

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
): Promise<void> {
  const mc = findMcBinary();

  await setupAlias(mc, minioConfig);

  const normalizedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const remotePath = `${MC_ALIAS}/${bucket}/${normalizedPrefix}`;

  if (fs.existsSync(localDir)) {
    fs.rmSync(localDir, { recursive: true, force: true });
  }
  fs.mkdirSync(localDir, { recursive: true });

  return new Promise<void>((resolve, reject) => {
    // --no-color avoids ANSI escape codes mixing into JSON output on Windows
    const args = ['mirror', '--overwrite', '--json', '--no-color', remotePath, localDir];
    let child: ChildProcess;
    try {
      child = spawn(mc, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (spawnErr) {
      // Synchronous spawn failure (e.g. binary not found on some platforms)
      fs.rmSync(localDir, { recursive: true, force: true });
      reject(new Error(`mc 启动失败: ${(spawnErr as Error).message}`));
      return;
    }

    let stderr = '';
    let transferredBytes = 0;
    let transferredCount = 0;
    let errorCount = 0;
    const errorMessages: string[] = [];
    let stdoutBuffer = '';

    console.log(`[mc-mirror] running: ${mc} mirror ... ${remotePath} -> ${localDir}`);

    child.stdout!.on('data', (chunk: Buffer) => {
      // Buffer incomplete lines between chunks
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.status === 'success') {
            // size = this file's bytes; totalSize = cumulative bytes so far
            if (typeof msg.totalSize === 'number') transferredBytes = msg.totalSize;
            if (typeof msg.totalCount === 'number') transferredCount = msg.totalCount;

            onProgress({
              variant,
              phase: 'downloading',
              percent: 0,
              downloadedBytes: transferredBytes,
              message: msg.target ? path.basename(String(msg.target)) : `${transferredCount} 文件已下载`,
            });
          } else if (msg.status === 'error') {
            errorCount++;
            const cause = msg.error?.cause?.message || msg.error?.message || trimmed;
            errorMessages.push(String(cause));
            console.error('[mc-mirror] error:', cause);
          }
        } catch {
          // non-JSON line (e.g. debug output), ignore
        }
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (err) => {
      // Clean up the partially-created directory on failure
      try { fs.rmSync(localDir, { recursive: true, force: true }); } catch { /* ignore */ }
      reject(new Error(`mc 启动失败: ${err.message}. 请确保 mc.exe 已放入 tools/ 目录或已在 PATH 中。`));
    });

    child.on('close', (code) => {
      // mc mirror exits with code 0 even when errors occurred for individual files.
      // Treat as failure when errors were reported and nothing was successfully downloaded.
      const hasErrors = errorCount > 0;
      const hasDownloads = transferredCount > 0;

      if (code === 0 && (!hasErrors || hasDownloads)) {
        if (hasErrors) {
          console.warn(`[mc-mirror] completed with ${errorCount} error(s), ${transferredCount} file(s) downloaded`);
        }
        onProgress({
          variant,
          phase: 'downloading',
          percent: 100,
          downloadedBytes: transferredBytes,
          message: `${transferredCount} 个文件下载完成`,
        });
        resolve();
      } else {
        // Clean up partial download on failure
        try { fs.rmSync(localDir, { recursive: true, force: true }); } catch { /* ignore */ }
        const errMsg = errorMessages[0]
          || stderr.trim()
          || `mc mirror 退出码: ${code}`;
        reject(new Error(errMsg));
      }
    });
  });
}

import { app, shell, dialog } from 'electron';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const UPDATE_URL = 'http://10.248.15.20/hub_dist/version.json';

export interface UpdateInfo {
  version: string;
  notes: string;
  url: string;
  date: string;
}

export interface UpdateStatus {
  available: boolean;
  currentVersion: string;
  updateInfo?: UpdateInfo;
  error?: string;
}

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
    }).on('error', reject);
  });
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

let downloadTempPath: string | null = null;

export async function checkForUpdates(): Promise<UpdateStatus> {
  try {
    const updateInfo = await fetchJson<UpdateInfo>(UPDATE_URL);
    const currentVersion = app.getVersion();
    const cmp = compareVersions(updateInfo.version, currentVersion);

    console.log(`[updater] current=${currentVersion}, latest=${updateInfo.version}, cmp=${cmp}`);

    return {
      available: cmp > 0,
      currentVersion,
      updateInfo,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[updater] check failed:', msg);
    return {
      available: false,
      currentVersion: app.getVersion(),
      error: msg,
    };
  }
}

export async function downloadAndInstall(status: UpdateStatus): Promise<void> {
  if (!status.available || !status.updateInfo) {
    throw new Error('No update available');
  }

  const win = null;

  const tempDir = app.getPath('temp');
  const fileName = 'Studio-Hub-Setup.exe';
  const tempPath = path.join(tempDir, fileName);

  console.log('[updater] downloading:', status.updateInfo.url, '->', tempPath);

  await new Promise<void>((resolve, reject) => {
    const client = status.updateInfo!.url.startsWith('https') ? https : http;
    const req = client.get(status.updateInfo!.url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const stream = fs.createWriteStream(tempPath);
      res.pipe(stream);
      stream.on('finish', () => { stream.close(); resolve(); });
      stream.on('error', reject);
    });
    req.on('error', reject);
  });

  console.log('[updater] download complete, launching installer');
  shell.openPath(tempPath);
}
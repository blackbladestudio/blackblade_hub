import { BrowserWindow, ipcMain } from 'electron';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type {
  AssetHiveReleaseStatus,
  AssetHiveStatus,
  LaunchResult,
  ScriptLogMessage,
  ScriptResult,
} from '../../types/ipc';
import { resolvePath } from '../utils';
import {
  ASSETHIVE_PRODUCT_NAME,
  ASSETHIVE_PUBLISHER,
  ASSETHIVE_REPOSITORY,
  compareVersions,
  getExpectedAssetHiveExecutable,
  getRegisteredAssetHiveExecutable,
  type GitHubReleasePayload,
  normalizeVersion,
  selectReleaseAssets,
} from '../services/assethive';

const execFileAsync = promisify(execFile);

function getProgramFilesRoot(): string {
  return process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files';
}

interface InstalledAssetHive {
  version: string;
  installPath: string | null;
}

async function queryInstallations(): Promise<InstalledAssetHive[]> {
  const command = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding;
  $items = @(
    Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue
    Get-ItemProperty 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue
    Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue
  ) | Where-Object { $_.DisplayName -match '^${ASSETHIVE_PRODUCT_NAME}( \\d+\\.\\d+\\.\\d+)?$' -and $_.Publisher -eq '${ASSETHIVE_PUBLISHER}' };
  [Console]::Out.Write((ConvertTo-Json -InputObject @($items | Select-Object DisplayVersion, InstallLocation, DisplayIcon) -Compress))`;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    const items = JSON.parse(stdout.trim()) as Array<Record<string, unknown>>;
    return items.flatMap((item) => {
      const version = normalizeVersion(item.DisplayVersion);
      return version ? [{
        version,
        installPath: getRegisteredAssetHiveExecutable(item.InstallLocation, item.DisplayIcon),
      }] : [];
    }).sort((left, right) => compareVersions(right.version, left.version));
  } catch {
    return [];
  }
}

export async function getAssetHiveStatus(): Promise<AssetHiveStatus> {
  const programFilesRoot = getProgramFilesRoot();
  const fallbackPath = getExpectedAssetHiveExecutable(programFilesRoot);
  const installations = await queryInstallations();
  const isExecutable = (candidate: string): boolean => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  const installed = installations.find((item) => isExecutable(item.installPath || fallbackPath));

  if (installed) {
    return { state: 'ready', isInstalled: true, installPath: installed.installPath || fallbackPath, version: installed.version };
  }
  if (isExecutable(fallbackPath) || installations.length > 0) {
    return {
      state: 'damaged',
      isInstalled: false,
      installPath: isExecutable(fallbackPath) ? fallbackPath : null,
      version: installations[0]?.version || null,
      error: 'AssetHive installation is incomplete. Reinstall or repair the application.',
    };
  }
  return { state: 'not-installed', isInstalled: false, installPath: null, version: null };
}

async function getAssetHiveReleaseStatus(): Promise<AssetHiveReleaseStatus> {
  try {
    const response = await fetch(`https://api.github.com/repos/${ASSETHIVE_REPOSITORY}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'BlackBlade-Hub',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub release query failed (${response.status})`);
    }
    const release = selectReleaseAssets(await response.json() as GitHubReleasePayload);
    const local = await getAssetHiveStatus();
    return {
      available: true,
      version: release.version,
      updateAvailable: Boolean(local.version && compareVersions(release.version, local.version) > 0),
      releaseUrl: release.releaseUrl,
    };
  } catch (error) {
    return {
      available: false,
      version: null,
      updateAvailable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sendScriptLog(
  getMainWindow: () => BrowserWindow | null,
  type: ScriptLogMessage['type'],
  msg: string,
): void {
  if (!msg.trim()) return;
  getMainWindow()?.webContents.send('script-log', { type, msg: msg.trim() } as ScriptLogMessage);
}

function installAssetHive(getMainWindow: () => BrowserWindow | null): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const scriptPath = resolvePath('tools/install_assethive.ps1');
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      resolve({ success: false, error: `AssetHive installer script not found: ${scriptPath}` });
      return;
    }
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { cwd: path.dirname(scriptPath), shell: false, windowsHide: true },
    );
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => sendScriptLog(getMainWindow, 'stdout', data.toString()));
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      sendScriptLog(getMainWindow, 'stderr', data.toString());
    });
    child.on('error', (error) => resolve({ success: false, error: error.message }));
    child.on('close', (code) => {
      resolve({
        success: code === 0,
        exitCode: code ?? undefined,
        error: code === 0 ? undefined : stderr.trim() || `Installer exited with code ${code}`,
      });
    });
  });
}

export async function launchAssetHive(): Promise<LaunchResult> {
  const status = await getAssetHiveStatus();
  if (
    status.state !== 'ready'
    || !status.installPath
    || !fs.existsSync(status.installPath)
  ) {
    return { success: false, error: status.error || 'AssetHive is not installed correctly.' };
  }
  try {
    const child = spawn(status.installPath, [], {
      cwd: path.dirname(status.installPath),
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: false,
    });
    child.unref();
    return { success: true, path: status.installPath, pid: child.pid };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerAssetHiveHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('assethive:get-status', getAssetHiveStatus);
  ipcMain.handle('assethive:get-release', getAssetHiveReleaseStatus);
  ipcMain.handle('assethive:install', () => installAssetHive(getMainWindow));
  ipcMain.handle('assethive:launch', launchAssetHive);
}

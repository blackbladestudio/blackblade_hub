import { ipcMain, shell } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

const execAsync = promisify(exec);

const UGS_DOWNLOAD_URL = 'https://www.unrealengine.com/en-US/unreal-engine/unreal-game-sync';
const UGS_MSI_URL = 'http://10.248.15.20:13340/api/v1/tools/ugs-msi?action=download';

function getTempDir(): string {
  return app.getPath('temp');
}

async function findUgsPath(): Promise<string | null> {
  const locations = [
    'C:\\Program Files (x86)\\UnrealGameSync\\UnrealGameSyncLauncher.exe',
    'C:\\Program Files (x86)\\Unreal Game Sync\\UnrealGameSync.exe',
    'C:\\Program Files\\Unreal Game Sync\\UnrealGameSync.exe',
  ];

  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }

  try {
    const psCmd = "Get-ChildItem -Path 'C:\\Program Files','C:\\Program Files (x86)' -Filter 'UnrealGameSync*.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName";
    const { stdout } = await execAsync(
      `powershell -Command "${psCmd}"`,
      { timeout: 60000 },
    );
    const exePath = stdout.trim();
    console.log('[UGS] PowerShell search result:', exePath || 'not found');
    if (exePath && fs.existsSync(exePath)) {
      return exePath;
    }
  } catch (e) {
    console.log('[UGS] PowerShell search error:', e);
  }

  try {
    const { stdout } = await execAsync('where UnrealGameSync 2>nul');
    const exePath = stdout.trim().split('\n')[0];
    if (exePath && fs.existsSync(exePath)) {
      return exePath;
    }
  } catch {
  }

  return null;
}

export function registerUgsHandlers(): void {
  ipcMain.handle('ugs:check-installed', async () => {
    console.log('[UGS] ugs:check-installed starting');
    const ugsPath = await findUgsPath();
    console.log('[UGS] check result:', ugsPath ? `found: ${ugsPath}` : 'not found');
    return { installed: !!ugsPath, path: ugsPath };
  });

  ipcMain.handle('ugs:launch', async () => {
    console.log('[UGS] ugs:launch 开始启动');
    const ugsPath = await findUgsPath();

    if (!ugsPath) {
      console.log('[UGS] 启动失败：未找到 UGS');
      return { success: false, error: '未找到 UGS 安装' };
    }

    console.log('[UGS] 启动路径:', ugsPath);
    const { spawn } = await import('child_process');
    spawn(ugsPath, [], { detached: true, stdio: 'ignore' }).unref();
    return { success: true };
  });

  ipcMain.handle('ugs:open-download', async () => {
    await shell.openExternal(UGS_DOWNLOAD_URL);
  });

  ipcMain.handle('ugs:download-and-install', async () => {
    const tempDir = getTempDir();
    const msiPath = path.join(tempDir, 'UnrealGameSync.msi');

    console.log('[UGS] 开始下载 MSI 到:', msiPath);

    try {
      await execAsync(
        `curl -L -o "${msiPath}" "${UGS_MSI_URL}"`,
        { timeout: 300000 },
      );

      if (!fs.existsSync(msiPath)) {
        console.log('[UGS] MSI 文件不存在');
        return { success: false, error: 'MSI 文件下载失败' };
      }

      const stats = fs.statSync(msiPath);
      console.log('[UGS] MSI 文件大小:', stats.size);

      console.log('[UGS] 启动 msiexec 安装');
      const { spawn } = await import('child_process');
      spawn('msiexec.exe', ['/i', msiPath], {
        detached: true,
        stdio: 'ignore',
      }).unref();

      return { success: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log('[UGS] 安装异常:', errorMsg);
      return { success: false, error: '安装失败: ' + errorMsg };
    }
  });
}
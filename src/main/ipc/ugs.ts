import { ipcMain, shell, BrowserWindow } from 'electron';
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

    console.log('[UGS] Download path:', msiPath);

    try {
      await execAsync(
        `curl -L -o "${msiPath}" "${UGS_MSI_URL}"`,
        { timeout: 300000 },
      );

      if (!fs.existsSync(msiPath)) {
        console.log('[UGS] MSI file not found');
        return { success: false, error: 'MSI 文件下载失败', path: null };
      }

      const stats = fs.statSync(msiPath);
      console.log('[UGS] MSI file size:', stats.size);

      console.log('[UGS] Starting msiexec install');
      const { spawn } = await import('child_process');
      spawn('msiexec.exe', ['/i', msiPath], {
        detached: true,
        stdio: 'ignore',
      }).unref();

      return { success: true, path: msiPath };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log('[UGS] Install error:', errorMsg);
      return { success: false, error: '安装失败: ' + errorMsg, path: null };
    }
  });

  /**
   * 通过 UGS 同步 UE 项目到最新 precompiled-binary + content
   * 在项目目录运行 UnrealGameSync.exe -sync
   */
  ipcMain.handle('ugs:sync-project', async (_event, uprojectPath: string) => {
    const ugsPath = await findUgsPath();
    if (!ugsPath) {
      return { success: false, error: '未找到 UGS 安装' };
    }

    if (!uprojectPath?.trim()) {
      return { success: false, error: '未配置 UE 项目路径' };
    }

    // 从 uproject 路径推导项目根目录
    const projectDir = uprojectPath.trim().endsWith('.uproject')
      ? path.dirname(uprojectPath.trim())
      : uprojectPath.trim();

    console.log('[UGS sync] projectDir:', projectDir, 'ugsPath:', ugsPath);

    // 查找主窗口用于发送脚本日志
    const mainWindow = BrowserWindow.getAllWindows()[0];

    return new Promise((resolve) => {
      import('child_process').then(({ spawn }) => {
        const proc = spawn(ugsPath, ['-sync'], {
          cwd: projectDir,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderrData = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
          const line = chunk.toString().trim();
          if (line) {
            stderrData += line + '\n';
            mainWindow?.webContents.send('script-log', { type: 'stderr', msg: '[UGS] ' + line });
          }
        });

        proc.stdout?.on('data', (chunk: Buffer) => {
          const line = chunk.toString().trim();
          if (line) {
            mainWindow?.webContents.send('script-log', { type: 'stdout', msg: '[UGS] ' + line });
          }
        });

        proc.on('close', (code: number | null) => {
          console.log('[UGS sync] exited with code:', code);
          if (code === 0) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: stderrData || `同步失败 (exit code: ${code})` });
          }
        });

        proc.on('error', (err: Error) => {
          console.error('[UGS sync] spawn error:', err);
          resolve({ success: false, error: err.message });
        });
      });
    });
  });
}
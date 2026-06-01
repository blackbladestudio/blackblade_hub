import { ipcMain, shell, BrowserWindow } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

const execAsync = promisify(exec);

const UGS_DOWNLOAD_URL = 'https://www.unrealengine.com/en-US/unreal-engine/unreal-game-sync';
const UGS_MSI_URL = 'http://10.248.15.20:13340/api/v1/tools/ugs-msi?action=download';
const HORDE_URL = 'http://10.248.15.20:13340';
const HORDE_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1lIjoiQW5vbnltb3VzIiwiaHR0cDovL2VwaWNnYW1lcy5jb20vdWUvaG9yZGUvcm9sZSI6ImFnZW50LXJlZ2lzdHJhdGlvbiIsImlzcyI6Imh0dHA6Ly9lM2FmYzUxNmYyOTU6MTMzNDAvIn0.iBY9Cu0fW4INloKRwQyMhzb0_ZqG8ak6wti0lzUyhis';

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
   * 命令行同步 UE 项目：p4 sync 同步内容 + Horde API 下载 precompiled binaries
   * 全程无 GUI 弹窗，日志实时输出到面板
   */
  ipcMain.handle('ugs:sync-project', async (_event, uprojectPath: string) => {
    if (!uprojectPath?.trim()) {
      return { success: false, error: '未配置 UE 项目路径' };
    }

    const mainWindow = BrowserWindow.getAllWindows()[0];
    const sendLog = (type: string, msg: string) =>
      mainWindow?.webContents.send('script-log', { type, msg });

    const projectDir = uprojectPath.trim().endsWith('.uproject')
      ? path.dirname(uprojectPath.trim())
      : uprojectPath.trim();

    sendLog('info', `[同步] 项目目录: ${projectDir}`);

    // ── Step 1: 获取 Perforce depot 路径 ──
    let depotPath = '';
    try {
      const { stdout } = await execAsync(
        `p4 where "${uprojectPath.trim()}"`,
        { cwd: projectDir, timeout: 30000 },
      );
      // p4 where 输出: //depot/path //client/path local/path
      const parts = stdout.trim().split(/\s+/);
      depotPath = parts[0] || '';
      sendLog('info', `[P4] depot 路径: ${depotPath}`);
    } catch (e) {
      sendLog('error', `[P4] 获取 depot 路径失败: ${e instanceof Error ? e.message : String(e)}`);
      depotPath = '//ProjectZion/mainline'; // fallback
      sendLog('warn', `[P4] 使用默认 depot 路径: ${depotPath}`);
    }

    // ── Step 2: p4 sync 同步内容（实时输出到面板） ──
    sendLog('info', `[P4] 开始同步内容...`);
    const syncResult = await spawnLog('p4', ['sync', `${depotPath}/...`], projectDir, sendLog);
    if (!syncResult.success) {
      sendLog('error', `[P4] 同步失败: ${syncResult.error}`);
      return { success: false, error: syncResult.error };
    }
    sendLog('info', `[P4] 内容同步完成`);

    // ── Step 3: 尝试从 Horde 下载 precompiled binaries ──
    try {
      sendLog('info', `[Horde] 检查服务器连接...`);
      const testRes = await execAsync(
        `curl -s --connect-timeout 5 -o nul -w "%{http_code}" "${HORDE_URL}/api/v1/server/ping"`,
        { timeout: 10000 },
      );
      const code = parseInt(testRes.stdout.trim());
      if (code === 200 || code === 401 || code === 403) {
        sendLog('info', `[Horde] 服务器可达，开始下载 precompiled binaries...`);
        const projectName = path.basename(projectDir);
        const binRes = await spawnLog(
          'curl',
          [
            '-L', '--connect-timeout', '30',
            '-H', `Authorization: Bearer ${HORDE_TOKEN}`,
            `${HORDE_URL}/api/v1/jobs/by_project/${projectName}/precompiled?stream=true`,
            '-o', path.join(projectDir, 'Engine', 'Binaries', 'Download.zip'),
          ],
          projectDir,
          sendLog,
        );
        if (binRes.success) {
          sendLog('info', `[Horde] precompiled binaries 下载完成`);
        } else {
          sendLog('warn', `[Horde] 下载被跳过或失败: ${binRes.error}`);
        }
      } else {
        sendLog('warn', `[Horde] 服务器不可达 (${code})，跳过二进制下载`);
      }
    } catch {
      sendLog('warn', `[Horde] 无法连接，跳过二进制下载`);
    }

    sendLog('info', `[同步] 项目已更新到最新，可启动编辑器`);
    return { success: true };
  });
}

interface SpawnResult { success: boolean; error?: string }

/**
 * Spawn 一个命令，实时将 stdout/stderr 输出到 log 面板
 */
function spawnLog(cmd: string, args: string[], cwd: string, sendLog: (type: string, msg: string) => void): Promise<SpawnResult> {
  return new Promise((resolve) => {
    import('child_process').then(({ spawn }) => {
      const proc = spawn(cmd, args, {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stderrAll = '';
      const tag = `[${cmd}] `;

      proc.stdout?.on('data', (chunk: Buffer) => {
        chunk.toString().split('\n').filter(Boolean).forEach(line => sendLog('stdout', tag + line));
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) {
          stderrAll += line + '\n';
          sendLog('stderr', tag + line);
        }
      });
      proc.on('close', (code: number | null) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: stderrAll || `exit code: ${code}` });
        }
      });
      proc.on('error', (err: Error) => resolve({ success: false, error: err.message }));
    });
  });
}
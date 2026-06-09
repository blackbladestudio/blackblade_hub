import { ipcMain, shell, BrowserWindow } from 'electron';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { loadConfig } from '../config';
import { DEFAULT_P4_SERVER } from '../../types/config';
import type { PerforceConfig } from '../../types/config';
import type { P4ListWorkspacesParams } from '../../types/ipc';
import {
  buildP4EnvForSync,
  listFilteredWorkspaces,
  readSourceControlSettings,
  resolveProjectDir,
} from '../p4-workspace';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

interface P4Settings {
  port: string;
  userName: string;
  workspace: string;
}

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

async function resolveP4Workspace(
  p4Config: PerforceConfig,
  projectDir: string,
  sendLog: (type: string, msg: string) => void,
): Promise<P4Settings> {
  const port = p4Config.server?.trim() || DEFAULT_P4_SERVER;
  const userName = p4Config.userName?.trim();
  if (!userName) {
    throw new Error('未配置 P4 User Name');
  }

  const configuredWorkspace = p4Config.workspace?.trim();
  if (configuredWorkspace) {
    sendLog('info', `[P4] 使用配置的工作区: ${configuredWorkspace}`);
    return { port, userName, workspace: configuredWorkspace };
  }

  sendLog('info', `[P4] 自动检测工作区 (${port} | ${userName})`);
  const { localHost, totalCount, workspaces } = await listFilteredWorkspaces(port, userName, projectDir);
  sendLog('info', `[P4] 本机 ${localHost}，服务器 ${totalCount} 个，过滤后 ${workspaces.length} 个`);

  if (workspaces.length === 0) {
    throw new Error('未找到可用工作区（Host 或 Root 不匹配），请在配置中选择 P4 Workspace');
  }
  if (workspaces.length > 1) {
    const names = workspaces.map((c) => c.name).join(', ');
    throw new Error(`找到多个可用工作区 (${names})，请在配置中选择 P4 Workspace`);
  }

  sendLog('info', `[P4] 自动选中工作区: ${workspaces[0].name}`);
  return { port, userName, workspace: workspaces[0].name };
}

export function registerUgsHandlers(): void {
  ipcMain.handle('ugs:list-workspaces', async (_event, params: P4ListWorkspacesParams) => {
    try {
      if (!params.uprojectPath?.trim()) {
        return { success: false, error: '未配置 UE 项目路径' };
      }
      if (!params.userName?.trim()) {
        return { success: false, error: '未填写 P4 User Name' };
      }

      const projectDir = resolveProjectDir(params.uprojectPath);
      const { localHost, totalCount, workspaces } = await listFilteredWorkspaces(
        params.server,
        params.userName,
        projectDir,
      );

      return {
        success: true,
        localHost,
        totalCount,
        workspaces,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('p4:auto-fill', async (_event, uprojectPath: string) => {
    if (!uprojectPath?.trim()) return {};
    const projectDir = resolveProjectDir(uprojectPath.trim());
    return readSourceControlSettings(projectDir);
  });

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
   * 同步 UE 项目：
   * 1. UGS sync — 更新 precompiled binaries（静默，CreateNoWindow）
   * 2. p4 sync  — 同步内容到最新（实时日志）
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

    // ── Step 1: UGS CLI sync — 更新 precompiled binaries（纯命令行，无 GUI） ──
    sendLog('info', '[UGS] 开始更新 precompiled binaries...');

    const UGS_CLI = 'C:\\Program Files (x86)\\UnrealGameSync\\ugs.exe';
    if (!fs.existsSync(UGS_CLI)) {
      sendLog('error', '[UGS] 未找到 ugs.exe CLI 工具');
      return { success: false, error: '未找到 ugs.exe，请确认 UGS 已安装' };
    }

    const ugsArgs = ['sync', 'latest', '-binaries', '-clobber', '-nogpf'];
    const ugsResult = await spawnLog(UGS_CLI, ugsArgs, projectDir, sendLog);

    if (!ugsResult.success) {
      sendLog('error', `[UGS] precompiled binary 更新失败: ${ugsResult.error}`);
      return { success: false, error: ugsResult.error };
    }

    // ── Step 2: p4 sync — 同步 content 到最新 ──
    sendLog('info', '[P4] 开始同步 content...');

    const appConfig = loadConfig();
    let p4Settings: P4Settings;
    try {
      p4Settings = await resolveP4Workspace(appConfig.perforce, projectDir, sendLog);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendLog('error', `[P4] ${msg}`);
      return { success: false, error: msg };
    }

    const p4Env = buildP4EnvForSync(p4Settings.port, p4Settings.userName, p4Settings.workspace);
    sendLog('info', `[P4] ${p4Settings.port} | ${p4Settings.userName} | ${p4Settings.workspace}`);

    // 获取 depot 路径（取 .uproject 所在目录的 depot 路径）
    let depotPath: string;
    try {
      let uprojectFile = uprojectPath.trim();
      if (!uprojectFile.endsWith('.uproject')) {
        const found = fs.readdirSync(projectDir).find((f) => f.endsWith('.uproject'));
        if (!found) throw new Error('未找到 .uproject 文件');
        uprojectFile = path.join(projectDir, found);
      }
      const { stdout } = await execFileAsync('p4', ['where', uprojectFile], {
        cwd: projectDir,
        timeout: 30000,
        env: p4Env,
      });
      // p4 where 输出格式: //depot/path/file.uproject //client/path/file.uproject D:\local\path\file.uproject
      const parts = stdout.trim().split(/\s+/);
      if (!parts[0]) {
        throw new Error('p4 where 未返回 depot 路径');
      }
      const filePath = parts[0];
      depotPath = filePath.substring(0, filePath.lastIndexOf('/'));
      sendLog('info', `[P4] depot: ${depotPath}/...`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendLog('error', `[P4] 无法获取 depot 路径: ${msg}`);
      return { success: false, error: `无法获取 depot 路径: ${msg}` };
    }

    const p4Result = await spawnLog(
      'p4', ['sync', `${depotPath}/...`],
      projectDir, sendLog, p4Env,
    );

    if (!p4Result.success) {
      sendLog('error', `[P4] sync 失败: ${p4Result.error}`);
      return { success: false, error: p4Result.error };
    }

    sendLog('info', '[同步] 项目已更新到最新，可启动编辑器');
    return { success: true };
  });
}

interface SpawnResult { success: boolean; error?: string }

/**
 * Spawn 一个命令，实时将 stdout/stderr 输出到 log 面板
 */
function spawnLog(
  cmd: string,
  args: string[],
  cwd: string,
  sendLog: (type: string, msg: string) => void,
  env?: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    import('child_process').then(({ spawn }) => {
      // 打印实际执行的命令
      const cmdDisplay = `"${cmd}" ${args.join(' ')}`;
      sendLog('info', `[exec] ${cmdDisplay}  (cwd: ${cwd})`);

      const proc = spawn(cmd, args, {
        cwd,
        env: env ?? process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stderrAll = '';
      const label = path.basename(cmd, '.exe');
      const tag = `[${label}] `;

      proc.stdout?.on('data', (chunk: Buffer) => {
        chunk.toString().split('\n').filter(Boolean).forEach(line => sendLog('stdout', tag + line));
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) {
          stderrAll += line + '\n';
          // p4 把正常状态信息（up-to-date、updating）也输出到 stderr，按内容判断类型
          const isP4Info = label === 'p4' && /^(\/\/|file\(s\)|\d+ file)/.test(line);
          sendLog(isP4Info ? 'stdout' : 'stderr', tag + line);
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
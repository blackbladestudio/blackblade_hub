import { ipcMain, BrowserWindow } from 'electron';
import { execSync, spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { BbCliStatus, CliOutputMessage } from '../../types/ipc';

let currentProcess: ChildProcess | null = null;
let getMainWindowFn: (() => BrowserWindow | null) | null = null;

function sendOutput(type: CliOutputMessage['type'], msg: string): void {
  if (getMainWindowFn) {
    const win = getMainWindowFn();
    win?.webContents.send('bb-cli-output', { type, msg } as CliOutputMessage);
  }
}

export function registerBbCliHandlers(getMainWindow: () => BrowserWindow | null): void {
  getMainWindowFn = getMainWindow;

  ipcMain.handle('get-bb-cli-status', async (): Promise<BbCliStatus> => {
    const installDir = path.join(process.env.USERPROFILE || '', '.blackblade');
    const bbExe = path.join(installDir, 'bb.exe');

    const isInstalled = fs.existsSync(bbExe);
    let version: string | null = null;

    if (isInstalled) {
      try {
        const result = execSync('bb --version', { encoding: 'utf-8', timeout: 5000 });
        version = result.trim() || null;
      } catch {
        try {
          const result = execSync('bb --version', { encoding: 'utf-8', timeout: 5000, shell: 'cmd.exe' });
          version = result.trim() || null;
        } catch {
          version = null;
        }
      }
    }

    return {
      isInstalled,
      installPath: isInstalled ? bbExe : null,
      version,
    };
  });

  ipcMain.handle('run-bb-cli-command', async (_event, args: string[]): Promise<{ success: boolean; error?: string }> => {
    if (currentProcess) {
      currentProcess.kill();
      currentProcess = null;
    }

    const installDir = path.join(process.env.USERPROFILE || '', '.blackblade');
    const bbExe = path.join(installDir, 'bb.exe');

    if (!fs.existsSync(bbExe)) {
      return { success: false, error: 'bb.exe not found. Please install BlackBlade CLI first.' };
    }

    try {
      const cmd = `"${bbExe}" ${args.join(' ')}`;
      sendOutput('info', `Executing: ${args.join(' ')}`);

      currentProcess = spawn('cmd.exe', ['/c', bbExe, ...args], {
        cwd: installDir,
        shell: false,
        windowsHide: true,
      });

      currentProcess.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => sendOutput('stdout', line));
      });

      currentProcess.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => sendOutput('stderr', line));
      });

      currentProcess.on('close', (code: number | null) => {
        sendOutput('exit', `Process exited with code ${code}`);
        currentProcess = null;
      });

      currentProcess.on('error', (err: Error) => {
        sendOutput('error', `Error: ${err.message}`);
        currentProcess = null;
      });

      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('kill-bb-cli-command', async (): Promise<{ success: boolean }> => {
    if (currentProcess) {
      currentProcess.kill();
      currentProcess = null;
      sendOutput('info', 'Process terminated');
      return { success: true };
    }
    return { success: true };
  });
}
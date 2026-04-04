import { ipcMain, BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { resolvePath } from '../utils';
import type { ScriptResult } from '../../types/ipc';

export function registerScriptHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    'run-script',
    (_event: Electron.IpcMainInvokeEvent, scriptPath: string): Promise<ScriptResult> => {
      return new Promise((resolve) => {
        const win = getMainWindow();
        const resolved = resolvePath(scriptPath);

        if (!resolved || !fs.existsSync(resolved)) {
          win?.webContents.send('script-log', {
            type: 'error',
            msg: 'Script not found: ' + resolved,
          });
          resolve({ success: false, error: 'Script not found: ' + resolved });
          return;
        }

        const ext = path.extname(resolved).toLowerCase();
        const args =
          ext === '.ps1'
            ? ['-ExecutionPolicy', 'Bypass', '-File', resolved]
            : ['/c', resolved];
        const cmd = ext === '.ps1' ? 'powershell.exe' : 'cmd.exe';

        win?.webContents.send('script-log', {
          type: 'info',
          msg: `> ${cmd} ${args.join(' ')}`,
        });

        const child = spawn(cmd, args, {
          cwd: path.dirname(resolved),
          shell: false,
        });

        child.stdout.on('data', (data: Buffer) => {
          win?.webContents.send('script-log', { type: 'stdout', msg: data.toString().trim() });
        });

        child.stderr.on('data', (data: Buffer) => {
          win?.webContents.send('script-log', { type: 'stderr', msg: data.toString().trim() });
        });

        child.on('close', (code: number | null) => {
          win?.webContents.send('script-log', {
            type: 'info',
            msg: `Process exited with code ${code}`,
          });
          resolve({ success: code === 0, exitCode: code ?? undefined });
        });

        child.on('error', (err: Error) => {
          win?.webContents.send('script-log', { type: 'error', msg: err.message });
          resolve({ success: false, error: err.message });
        });
      });
    },
  );
}

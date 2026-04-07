import { ipcMain, shell, dialog, BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { resolvePath } from '../utils';
import type { LaunchResult } from '../../types/ipc';

export function registerLaunchHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('open-url', (_event: Electron.IpcMainInvokeEvent, url: string) => {
    if (url && url.startsWith('http')) {
      shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle(
    'launch-app',
    (_event: Electron.IpcMainInvokeEvent, appPath: string): Promise<LaunchResult> => {
      const resolved = resolvePath(appPath);
      if (!resolved || !fs.existsSync(resolved)) {
        return Promise.resolve({ success: false, error: 'File not found: ' + resolved });
      }

      const ext = path.extname(resolved).toLowerCase();
      let child;

      if (ext === '.exe') {
        child = spawn(resolved, [], {
          stdio: 'ignore',
          detached: true,
          shell: false,
          cwd: path.dirname(resolved),
        });
      } else if (ext === '.ps1') {
        child = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', resolved], {
          stdio: 'ignore',
          detached: true,
          shell: false,
        });
      } else if (ext === '.bat' || ext === '.cmd') {
        child = spawn('cmd.exe', ['/c', resolved], {
          stdio: 'ignore',
          detached: true,
          shell: false,
        });
      } else {
        child = spawn('cmd.exe', ['/c', 'start', '', resolved], {
          stdio: 'ignore',
          detached: true,
          shell: false,
        });
      }

      child.unref();
      return Promise.resolve({ success: true });
    },
  );

  ipcMain.handle(
    'select-file',
    async (_event: Electron.IpcMainInvokeEvent, defaultPath?: string) => {
      const win = getMainWindow();
      if (!win) return null;

      const result = await dialog.showOpenDialog(win, {
        defaultPath: defaultPath || undefined,
        properties: ['openFile'],
        filters: [
          { name: 'Scripts', extensions: ['ps1', 'bat', 'cmd', 'exe'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      return result.canceled ? null : result.filePaths[0];
    },
  );

  ipcMain.handle('select-uproject', async () => {
    const win = getMainWindow();
    if (!win) return null;

    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Unreal Project', extensions: ['uproject'] }],
    });

    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(
    'launch-editor',
    async (_event: Electron.IpcMainInvokeEvent, uprojectPath: string): Promise<LaunchResult> => {
      const resolved = resolvePath(uprojectPath);
      if (!resolved || !fs.existsSync(resolved)) {
        return { success: false, error: 'Project file not found: ' + resolved };
      }

      const editorPath = findUE5Editor(uprojectPath);
      if (!editorPath) {
        return { success: false, error: '未找到 UnrealEditor.exe，请确认工程目录结构正确（应有 Engine/Binaries/Win64/UnrealEditor.exe）' };
      }

      const child = spawn(editorPath, [resolved], {
        stdio: 'ignore',
        detached: true,
        shell: false,
        cwd: path.dirname(resolved),
      });

      child.unref();
      return { success: true };
    },
  );
}

function findUE5Editor(uprojectPath: string): string | null {
  const projectRoot = path.dirname(uprojectPath);
  const gameRoot = path.dirname(projectRoot);
  const editorPath = path.join(gameRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
  if (fs.existsSync(editorPath)) {
    return editorPath;
  }
  return null;
}

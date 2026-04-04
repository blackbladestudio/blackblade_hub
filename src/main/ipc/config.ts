import { ipcMain } from 'electron';
import { loadConfig, saveConfig } from '../config';
import type { AppConfig } from '../../types/config';

export function registerConfigHandlers(): void {
  ipcMain.handle('get-config', () => loadConfig());

  ipcMain.handle('save-config', (_event: Electron.IpcMainInvokeEvent, config: AppConfig) => {
    saveConfig(config);
    return true;
  });
}

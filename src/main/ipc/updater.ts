import { ipcMain, BrowserWindow } from 'electron';
import * as autoUpdater from '../services/auto-updater';

export function registerUpdaterHandlers(): void {
  ipcMain.handle('updater:check', async () => {
    const status = await autoUpdater.checkForUpdates();
    console.log('[updater IPC] check result:', status);
    return status;
  });

  ipcMain.handle('updater:download-and-install', async () => {
    const status = await autoUpdater.checkForUpdates();
    if (!status.available) {
      return { success: false, error: '没有可用更新' };
    }
    try {
      await autoUpdater.downloadAndInstall(status);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
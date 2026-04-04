import { ipcMain, BrowserWindow } from 'electron';

export function registerWindowHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.on('win-minimize', () => {
    getMainWindow()?.minimize();
  });

  ipcMain.on('win-maximize', () => {
    const win = getMainWindow();
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });

  ipcMain.on('win-close', () => {
    getMainWindow()?.close();
  });
}

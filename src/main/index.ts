import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import path from 'path';
import { bootstrapConfig, loadConfig } from './config';
import { registerAllHandlers } from './ipc';
import * as gameManager from './services/game-manager';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function getIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', 'icon.ico');
  }
  return path.join(__dirname, '..', '..', 'assets', 'icon.ico');
}

function createTray(): void {
  const iconPath = getIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('BlackBlade Hub');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    title: 'BlackBlade Hub',
    backgroundColor: '#080b10',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.openDevTools();

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    bootstrapConfig();
    registerAllHandlers(getMainWindow);
    createWindow();
    createTray();

    const config = loadConfig();
    if (config.minio?.endpoint && config.launcher?.prefix) {
      gameManager.checkForUpdates(config.minio, config.launcher).then((results) => {
        const updates = results.filter((r) => r.needsSync);
        if (updates.length > 0) {
          for (const r of updates) {
            console.log(`[hub] ${r.variant} 有新版本: ${r.remoteVersion} (当前: ${r.localVersion})`);
          }
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('launcher-update-available', updates.map((r) => ({
              variant: r.variant,
              localVersion: r.localVersion,
              remoteVersion: r.remoteVersion,
            })));
          }
        }
      }).catch((err) => {
        console.warn('[hub] 启动时版本检测失败:', err.message);
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

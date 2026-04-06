import { ipcMain, dialog, BrowserWindow } from 'electron';
import { loadConfig } from '../config';
import * as minioClient from '../services/minio-client';
import * as gameManager from '../services/game-manager';
import type { GameVariant } from '../../types/launcher';

export function registerLauncherHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('launcher:test-connection', async () => {
    try {
      const { minio } = loadConfig();
      if (!minio?.endpoint) return { success: false, error: 'MinIO 未配置' };
      await minioClient.testConnection(minio);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('launcher:get-manifest', async () => {
    try {
      const config = loadConfig();
      if (!config.minio?.endpoint) return { data: null, error: 'MinIO 服务器未配置' };
      if (!config.launcher?.prefix) return { data: null, error: '构建路径前缀未配置' };
      const manifest = await minioClient.getBuilds(
        config.minio,
        config.launcher.prefix,
        config.launcher.exeRelativePath || '',
      );
      return { data: manifest };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[launcher] get-manifest error:', msg);
      return { data: null, error: msg };
    }
  });

  ipcMain.handle('launcher:get-state', () => {
    return gameManager.loadState();
  });

  ipcMain.handle('launcher:install', async (_event, variant: GameVariant) => {
    try {
      const config = loadConfig();
      if (!config.minio?.endpoint) return { success: false, error: 'MinIO 未配置' };
      if (!config.launcher?.installDir) return { success: false, error: '安装目录未设置' };
      if (!config.launcher?.prefix) return { success: false, error: '构建路径前缀未设置' };

      const manifest = await minioClient.getBuilds(
        config.minio,
        config.launcher.prefix,
        config.launcher.exeRelativePath || '',
      );

      const build = manifest.builds
        .filter((b) => b.variant === variant)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

      if (!build) return { success: false, error: `无可用的 ${variant} 构建` };

      await gameManager.installBuild(build, config.minio, config.launcher, getMainWindow());
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('launcher:launch', async (_event, variant: GameVariant) => {
    try {
      gameManager.launchBuild(variant);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('launcher:uninstall', async (_event, variant: GameVariant) => {
    try {
      gameManager.uninstallBuild(variant);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('launcher:select-install-dir', async () => {
    const win = getMainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
}

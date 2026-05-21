import { contextBridge, ipcRenderer } from 'electron';
import type { StudioHubAPI } from '../types/ipc';

const api: StudioHubAPI = {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  runScript: (scriptPath) => ipcRenderer.invoke('run-script', scriptPath),
  launchApp: (appPath) => ipcRenderer.invoke('launch-app', appPath),
  selectFile: (defaultPath) => ipcRenderer.invoke('select-file', defaultPath),
  selectUproject: () => ipcRenderer.invoke('select-uproject'),
  launchEditor: (uprojectPath) => ipcRenderer.invoke('launch-editor', uprojectPath),
  onScriptLog: (callback) => {
    ipcRenderer.on('script-log', (_e, msg) => callback(msg));
  },
  getHordeAgentStatus: () => ipcRenderer.invoke('get-horde-agent-status'),
  startHordeAgent: () => ipcRenderer.invoke('start-horde-agent'),
  stopHordeAgent: () => ipcRenderer.invoke('stop-horde-agent'),
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),

  // Launcher
  launcherGetManifest: () => ipcRenderer.invoke('launcher:get-manifest'),
  launcherGetState: () => ipcRenderer.invoke('launcher:get-state'),
  launcherInstall: (variant, objectKey) => ipcRenderer.invoke('launcher:install', variant, objectKey),
  launcherLaunch: (variant) => ipcRenderer.invoke('launcher:launch', variant),
  launcherUninstall: (variant) => ipcRenderer.invoke('launcher:uninstall', variant),
  launcherTestConnection: () => ipcRenderer.invoke('launcher:test-connection'),
  launcherSelectInstallDir: () => ipcRenderer.invoke('launcher:select-install-dir'),
  launcherOpenInstallDir: (variant) => ipcRenderer.invoke('launcher:open-install-dir', variant),
  launcherCheckRunning: (variant) => ipcRenderer.invoke('launcher:check-running', variant),
  launcherStop: (variant) => ipcRenderer.invoke('launcher:stop', variant),
  launcherCheckUpdates: (variant, objectKey) => ipcRenderer.invoke('launcher:check-updates', variant, objectKey),
  launcherSyncVariant: (variant, objectKey) => ipcRenderer.invoke('launcher:sync-variant', variant, objectKey),
  onLauncherProgress(callback) {
    ipcRenderer.on('launcher-progress', (_e, progress) => callback(progress));
  },
  onLauncherUpdateAvailable(callback) {
    ipcRenderer.on('launcher-update-available', (_e, updates) => callback(updates));
  },
  launcherForceCheckUpdates: (variant, objectKey) =>
    ipcRenderer.invoke('launcher:force-check-updates', variant, objectKey),
  launcherAbortInstall: () => ipcRenderer.invoke('launcher:abort-install'),

  // Updater
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownloadAndInstall: () => ipcRenderer.invoke('updater:download-and-install'),

  // UGS
  ugsCheckInstalled: () => ipcRenderer.invoke('ugs:check-installed'),
  ugsLaunch: () => ipcRenderer.invoke('ugs:launch'),
  ugsOpenDownload: () => ipcRenderer.invoke('ugs:open-download'),
  ugsDownloadAndInstall: () => ipcRenderer.invoke('ugs:download-and-install'),
};

contextBridge.exposeInMainWorld('studioHub', api);

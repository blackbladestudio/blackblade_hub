import { contextBridge, ipcRenderer } from 'electron';
import type { StudioHubAPI } from '../types/ipc';

const api: StudioHubAPI = {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  runScript: (scriptPath) => ipcRenderer.invoke('run-script', scriptPath),
  launchApp: (appPath) => ipcRenderer.invoke('launch-app', appPath),
  selectFile: (defaultPath) => ipcRenderer.invoke('select-file', defaultPath),
  onScriptLog: (callback) => {
    ipcRenderer.on('script-log', (_e, msg) => callback(msg));
  },
  getHordeAgentStatus: () => ipcRenderer.invoke('get-horde-agent-status'),
  startHordeAgent: () => ipcRenderer.invoke('start-horde-agent'),
  stopHordeAgent: () => ipcRenderer.invoke('stop-horde-agent'),
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),
};

contextBridge.exposeInMainWorld('studioHub', api);

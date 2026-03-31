const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioHub', {
  getConfig:   ()           => ipcRenderer.invoke('get-config'),
  saveConfig:  (config)     => ipcRenderer.invoke('save-config', config),
  openUrl:     (url)        => ipcRenderer.invoke('open-url', url),
  runScript:   (scriptPath) => ipcRenderer.invoke('run-script', scriptPath),
  launchApp:   (appPath)    => ipcRenderer.invoke('launch-app', appPath),
  selectFile:  (defaultPath)=> ipcRenderer.invoke('select-file', defaultPath),
  winMinimize: ()           => ipcRenderer.send('win-minimize'),
  winMaximize: ()           => ipcRenderer.send('win-maximize'),
  winClose:    ()           => ipcRenderer.send('win-close')
});

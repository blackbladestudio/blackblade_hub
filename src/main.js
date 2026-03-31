const { app, BrowserWindow, shell, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const DEFAULT_CONFIG = {
  gameExe: '',
  editorExe: '',
  tools: [],
  jenkins: 'http://10.248.15.20:8080/',
  horde: 'http://10.248.15.20:13340',
  ugs: '',
  envScript: ''
};

let CONFIG_DIR = '';
let CONFIG_PATH = '';

function getDefaultConfigPath() {
  return path.join(app.getAppPath(), 'config.default.json');
}

function ensureUserConfigDir() {
  const userDataPath = app.getPath('userData');
  CONFIG_DIR = userDataPath;
  CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function bootstrapConfig() {
  ensureUserConfigDir();

  if (!fs.existsSync(CONFIG_PATH)) {
    const defaultPath = getDefaultConfigPath();
    if (fs.existsSync(defaultPath)) {
      try {
        const raw = fs.readFileSync(defaultPath, 'utf-8');
        const defaultCfg = JSON.parse(raw);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultCfg, null, 2), 'utf-8');
        return defaultCfg;
      } catch (e) {}
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch (e) {}
  return DEFAULT_CONFIG;
}

function saveConfig(data) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {}
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    title: 'Studio Hub',
    backgroundColor: '#080b10',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  bootstrapConfig();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-config', () => loadConfig());

ipcMain.handle('save-config', (event, config) => {
  saveConfig(config);
  return true;
});

ipcMain.handle('open-url', (event, url) => {
  if (url && url.startsWith('http')) {
    shell.openExternal(url);
    return true;
  }
  return false;
});

ipcMain.handle('run-script', (event, scriptPath) => {
  return new Promise((resolve) => {
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      resolve({ success: false, error: 'Script not found: ' + scriptPath });
      return;
    }
    const ext = path.extname(scriptPath).toLowerCase();
    let child;
    if (ext === '.ps1') {
      child = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        stdio: 'ignore',
        detached: true,
        shell: false
      });
    } else if (ext === '.bat' || ext === '.cmd') {
      child = spawn('cmd.exe', ['/c', scriptPath], {
        stdio: 'ignore',
        detached: true,
        shell: false
      });
    } else if (ext === '.exe') {
      child = spawn(scriptPath, [], {
        stdio: 'ignore',
        detached: true,
        shell: false
      });
    } else {
      child = spawn('cmd.exe', ['/c', 'start', '', scriptPath], {
        stdio: 'ignore',
        detached: true,
        shell: false
      });
    }
    child.unref();
    setTimeout(() => resolve({ success: true }), 1000);
  });
});

ipcMain.handle('launch-app', (event, appPath) => {
  return new Promise((resolve) => {
    if (!appPath || !fs.existsSync(appPath)) {
      resolve({ success: false, error: 'File not found: ' + appPath });
      return;
    }
    const ext = path.extname(appPath).toLowerCase();
    let child;
    if (ext === '.exe') {
      child = spawn(appPath, [], {
        stdio: 'ignore',
        detached: true,
        shell: false,
        cwd: path.dirname(appPath)
      });
    } else if (ext === '.ps1') {
      child = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', appPath], {
        stdio: 'ignore',
        detached: true,
        shell: false
      });
    } else if (ext === '.bat' || ext === '.cmd') {
      child = spawn('cmd.exe', ['/c', appPath], {
        stdio: 'ignore',
        detached: true,
        shell: false
      });
    } else {
      child = spawn('cmd.exe', ['/c', 'start', '', appPath], {
        stdio: 'ignore',
        detached: true,
        shell: false
      });
    }
    child.unref();
    setTimeout(() => resolve({ success: true }), 800);
  });
});

ipcMain.handle('select-file', async (event, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: defaultPath || undefined,
    properties: ['openFile'],
    filters: [
      { name: 'Scripts', extensions: ['ps1', 'bat', 'cmd', 'exe'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win-close', () => mainWindow && mainWindow.close());

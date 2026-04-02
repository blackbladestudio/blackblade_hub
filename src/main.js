const { app, BrowserWindow, shell, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const APP_NAME = 'BlackBlade Hub';

let CONFIG_PATH = '';

function getDefaultConfigPath() {
  return path.join(app.getAppPath(), 'src', 'config.default.json');
}

function getUserConfigPath() {
  const userDataPath = process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
  return path.join(userDataPath, APP_NAME, 'config.json');
}

function ensureUserConfigDir() {
  CONFIG_PATH = getUserConfigPath();
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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
    const fallback = { gameExe: '', editorExe: '', tools: [], jenkins: '', horde: '', ugs: '', envScript: '' };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(fallback, null, 2), 'utf-8');
  }
}

function loadConfig() {
  const defaultPath = getDefaultConfigPath();
  let defaultCfg = {};
  if (fs.existsSync(defaultPath)) {
    try {
      defaultCfg = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
    } catch (e) {}
  }
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const userCfg = JSON.parse(raw);
      return { ...defaultCfg, ...userCfg };
    }
  } catch (e) {}
  return defaultCfg;
}

function saveConfig(data) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {}
}

let mainWindow;

function getMainWindow() {
  return BrowserWindow.getAllWindows()[0];
}

ipcMain.handle('run-script', (event, scriptPath) => {
  return new Promise((resolve) => {
    const resolved = resolvePath(scriptPath);
    if (!resolved || !fs.existsSync(resolved)) {
      mainWindow.webContents.send('script-log', { type: 'error', msg: 'Script not found: ' + resolved });
      resolve({ success: false, error: 'Script not found: ' + resolved });
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const args = ext === '.ps1'
      ? ['-ExecutionPolicy', 'Bypass', '-File', resolved]
      : ['/c', resolved];
    const cmd = ext === '.ps1' ? 'powershell.exe' : 'cmd.exe';

    mainWindow.webContents.send('script-log', { type: 'info', msg: `> ${cmd} ${args.join(' ')}` });

    const child = spawn(cmd, args, {
      cwd: app.getAppPath(),
      shell: false
    });

    child.stdout.on('data', (data) => {
      mainWindow.webContents.send('script-log', { type: 'stdout', msg: data.toString().trim() });
    });

    child.stderr.on('data', (data) => {
      mainWindow.webContents.send('script-log', { type: 'stderr', msg: data.toString().trim() });
    });

    child.on('close', (code) => {
      mainWindow.webContents.send('script-log', { type: 'info', msg: `Process exited with code ${code}` });
      resolve({ success: code === 0, exitCode: code });
    });

    child.on('error', (err) => {
      mainWindow.webContents.send('script-log', { type: 'error', msg: err.message });
      resolve({ success: false, error: err.message });
    });
  });
});

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

function resolvePath(p) {
  if (!p) return '';
  if (path.isAbsolute(p)) return p;
  return path.join(app.getAppPath(), p);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    title: 'BlackBlade Hub',
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

ipcMain.handle('launch-app', (event, appPath) => {
  const resolved = resolvePath(appPath);
  if (!resolved || !fs.existsSync(resolved)) {
    return { success: false, error: 'File not found: ' + resolved };
  }
  const ext = path.extname(resolved).toLowerCase();
  let child;
  if (ext === '.exe') {
    child = spawn(resolved, [], {
      stdio: 'ignore',
      detached: true,
      shell: false,
      cwd: path.dirname(resolved)
    });
  } else if (ext === '.ps1') {
    child = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', resolved], {
      stdio: 'ignore',
      detached: true,
      shell: false
    });
  } else if (ext === '.bat' || ext === '.cmd') {
    child = spawn('cmd.exe', ['/c', resolved], {
      stdio: 'ignore',
      detached: true,
      shell: false
    });
  } else {
    child = spawn('cmd.exe', ['/c', 'start', '', resolved], {
      stdio: 'ignore',
      detached: true,
      shell: false
    });
  }
  child.unref();
  return Promise.resolve({ success: true });
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

ipcMain.handle('get-horde-agent-status', async () => {
  const workDir = process.env.LOCALAPPDATA + '\\HordeAgent';
  const agentExe = path.join(workDir, 'HordeAgent.exe');
  const configPath = path.join(app.getAppPath(), 'tools', 'horde_config.ps1');

  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const urlMatch = content.match(/\$HORDE_SERVE_URL\s*=\s*["']([^"']+)["']/);
      const tokenMatch = content.match(/\$HORDE_SERVER_TOKEN\s*=\s*["']([^"']+)["']/);
      if (urlMatch) config.serverUrl = urlMatch[1];
      if (tokenMatch) config.serverToken = tokenMatch[1];
    } catch (e) {}
  }

  let isInstalled = fs.existsSync(agentExe);
  let isRunning = false;
  let pid = null;

  try {
    const { execSync } = require('child_process');
    const result = execSync('tasklist /FI "IMAGENAME eq HordeAgent.exe" /FO CSV /NH', { encoding: 'utf-8' });
    if (result.includes('HordeAgent.exe')) {
      isRunning = true;
      const match = result.match(/(\d+)/);
      if (match) pid = parseInt(match[1]);
    }
  } catch (e) {}

  return { isInstalled, isRunning, pid, config, workDir };
});

ipcMain.handle('start-horde-agent', async () => {
  const workDir = process.env.LOCALAPPDATA + '\\HordeAgent';
  const agentExe = path.join(workDir, 'HordeAgent.exe');
  const agentLog = path.join(workDir, 'agent.log');

  if (!fs.existsSync(agentExe)) {
    return { success: false, error: 'HordeAgent not found at: ' + agentExe };
  }

  try {
    const child = spawn(agentExe, ['run', '--log', agentLog], {
      cwd: workDir,
      detached: true,
      stdio: 'ignore',
      shell: false
    });
    child.unref();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('stop-horde-agent', async () => {
  try {
    const { execSync } = require('child_process');
    execSync('taskkill /F /IM HordeAgent.exe', { stdio: 'ignore', windowsHide: true });
    return { success: true };
  } catch (e) {
    return { success: false, error: '停止失败: ' + e.message };
  }
});

ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win-close', () => mainWindow && mainWindow.close());

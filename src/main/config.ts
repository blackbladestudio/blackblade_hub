import path from 'path';
import fs from 'fs';
import type { AppConfig } from '../types/config';
import { DEFAULT_CONFIG } from '../types/config';

const APP_NAME = 'BlackBlade Hub';

let configPath = '';

function getDefaultConfigPath(): string {
  return path.join(__dirname, '..', 'config.default.json');
}

function getUserConfigPath(): string {
  const userDataPath =
    process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
  return path.join(userDataPath, APP_NAME, 'config.json');
}

function ensureUserConfigDir(): void {
  configPath = getUserConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function bootstrapConfig(): void {
  ensureUserConfigDir();

  if (!fs.existsSync(configPath)) {
    const defaultPath = getDefaultConfigPath();
    if (fs.existsSync(defaultPath)) {
      try {
        const raw = fs.readFileSync(defaultPath, 'utf-8');
        const defaultCfg = JSON.parse(raw);
        fs.writeFileSync(configPath, JSON.stringify(defaultCfg, null, 2), 'utf-8');
        return;
      } catch {
        // fall through to write fallback
      }
    }
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
  }
}

export function loadConfig(): AppConfig {
  const defaultPath = getDefaultConfigPath();
  let defaultCfg: Partial<AppConfig> = {};
  if (fs.existsSync(defaultPath)) {
    try {
      defaultCfg = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
    } catch {
      // ignore
    }
  }

  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const userCfg = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...defaultCfg, ...userCfg };
    }
  } catch {
    // ignore
  }

  return { ...DEFAULT_CONFIG, ...defaultCfg };
}

export function saveConfig(data: AppConfig): void {
  try {
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

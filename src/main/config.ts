import path from 'path';
import fs from 'fs';
import type { AppConfig } from '../types/config';
import { DEFAULT_CONFIG } from '../types/config';

const APP_NAME = 'BlackBlade Hub';

/** 应用级字段，不写入用户配置文件 */
const APP_ONLY_KEYS: (keyof AppConfig)[] = ['studioHome', 'studioChat', 'studioHue'];

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
        // 初始化用户配置时剔除应用级字段
        for (const key of APP_ONLY_KEYS) delete defaultCfg[key];
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
      const merged = { ...DEFAULT_CONFIG, ...defaultCfg, ...userCfg };
      merged.minio = { ...DEFAULT_CONFIG.minio, ...(defaultCfg as any).minio, ...userCfg.minio };
      // 将已保存的旧默认地址迁移到新服务器，保留其他自定义地址。
      if (typeof merged.minio.endpoint === 'string' && merged.minio.endpoint.replace(/\/+$/, '') === 'http://10.248.15.20:9000') {
        merged.minio.endpoint = (defaultCfg as any).minio?.endpoint ?? DEFAULT_CONFIG.minio.endpoint;
      }
      merged.launcher = { ...DEFAULT_CONFIG.launcher, ...(defaultCfg as any).launcher, ...userCfg.launcher };
      merged.perforce = { ...DEFAULT_CONFIG.perforce, ...(defaultCfg as any).perforce, ...userCfg.perforce };
      // 门户地址为应用级配置，始终使用 config.default.json 的值，不允许用户覆盖
      if ((defaultCfg as any).studioHome) merged.studioHome = (defaultCfg as any).studioHome;
      if ((defaultCfg as any).studioChat) merged.studioChat = (defaultCfg as any).studioChat;
      if ((defaultCfg as any).studioHue) merged.studioHue = (defaultCfg as any).studioHue;
      return merged;
    }
  } catch {
    // ignore
  }

  const base = { ...DEFAULT_CONFIG, ...defaultCfg };
  base.minio = { ...DEFAULT_CONFIG.minio, ...(defaultCfg as any).minio };
  base.launcher = { ...DEFAULT_CONFIG.launcher, ...(defaultCfg as any).launcher };
  base.perforce = { ...DEFAULT_CONFIG.perforce, ...(defaultCfg as any).perforce };
  return base;
}

export function saveConfig(data: AppConfig): void {
  try {
    const stripped: Record<string, unknown> = { ...data };
    for (const key of APP_ONLY_KEYS) delete stripped[key];
    fs.writeFileSync(configPath, JSON.stringify(stripped, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

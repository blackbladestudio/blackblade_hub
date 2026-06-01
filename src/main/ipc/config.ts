import { ipcMain } from 'electron';
import { loadConfig, saveConfig } from '../config';
import type { AppConfig } from '../../types/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function registerConfigHandlers(): void {
  ipcMain.handle('get-config', () => loadConfig());

  ipcMain.handle('save-config', (_event: Electron.IpcMainInvokeEvent, config: AppConfig) => {
    saveConfig(config);
    syncUeProjectToCli(config.uprojectPath);
    return true;
  });
}

/**
 * 将 Hub 中的 UE 项目路径同步写入 CLI 配置文件
 * 优先写 Hub 工作目录的 blackblade.toml（CLI 当前目录优先级最高）
 * 备用于用户目录 %USERPROFILE%\.blackblade\config.toml
 */
function syncUeProjectToCli(uprojectPath: string): void {
  if (!uprojectPath?.trim()) return;

  const localPath = path.join(process.cwd(), 'blackblade.toml');
  const homePath = path.join(os.homedir(), '.blackblade', 'config.toml');
  const homeDir = path.dirname(homePath);

  try {
    const resolvedPath = path.resolve(uprojectPath.trim());
    const uproject = resolvedPath.endsWith('.uproject')
      ? resolvedPath
      : resolvedPath; // 若传入目录，保持不变，CLI 内部会找 .uproject

    const targets = [
      { path: localPath, label: 'local' },
      { path: homePath, label: 'home', ensureDir: homeDir },
    ];

    for (const target of targets) {
      let existingConfig = '';
      if (fs.existsSync(target.path)) {
        existingConfig = fs.readFileSync(target.path, 'utf-8');
      }

      const updated = updateTomlConfig(existingConfig, resolvedPath);

      if (target.ensureDir && !fs.existsSync(target.ensureDir)) {
        fs.mkdirSync(target.ensureDir, { recursive: true });
      }
      fs.writeFileSync(target.path, updated, 'utf-8');
      console.log(`[syncUeProjectToCli] 已同步 UE 项目到 CLI (${target.label}): ${target.path}`);
    }
  } catch (e) {
    console.error('[syncUeProjectToCli] 同步失败:', e);
  }
}

/**
 * 简单 TOML 配置更新：替换 ue.project_path 和设置 projects.zion
 */
function updateTomlConfig(existing: string, uprojectPath: string): string {
  const pp = uprojectPath.replace(/\\/g, '\\\\');
  const zionEntry = `zion = '${pp}'`;
  let result = existing;

  // 替换或插入 ue.project_path
  if (/^\s*project_path\s*=/m.test(result)) {
    result = result.replace(/^\s*project_path\s*=.*/m, `project_path = '${pp}'`);
  } else if (/^\[ue\]/m.test(result)) {
    result = result.replace(/^(\[ue\])/m, `$1\nproject_path = '${pp}'`);
  } else {
    result = result + `\n[ue]\nproject_path = '${pp}'\n`;
  }

  // 替换或插入 projects.zion
  if (/^\s*zion\s*=/m.test(result)) {
    result = result.replace(/^\s*zion\s*=.*/m, zionEntry);
  } else if (/^\[projects\]/m.test(result)) {
    result = result.replace(/^(\[projects\])/m, `$1\n${zionEntry}`);
  } else {
    result = result + `\n[projects]\n${zionEntry}\n`;
  }

  return result;
}

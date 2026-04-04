import { ipcMain } from 'electron';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { resolvePath } from '../utils';
import type { HordeAgentStatus, LaunchResult } from '../../types/ipc';

export function registerHordeHandlers(): void {
  ipcMain.handle('get-horde-agent-status', async (): Promise<HordeAgentStatus> => {
    const workDir = path.join(process.env.LOCALAPPDATA || '', 'HordeAgent');
    const agentExe = path.join(workDir, 'HordeAgent.exe');
    const cfgPath = resolvePath('tools/horde_config.ps1');

    const config: { serverUrl?: string; serverToken?: string } = {};
    if (cfgPath && fs.existsSync(cfgPath)) {
      try {
        const content = fs.readFileSync(cfgPath, 'utf-8');
        const urlMatch = content.match(/\$HORDE_SERVE_URL\s*=\s*["']([^"']+)["']/);
        const tokenMatch = content.match(/\$HORDE_SERVER_TOKEN\s*=\s*["']([^"']+)["']/);
        if (urlMatch) config.serverUrl = urlMatch[1];
        if (tokenMatch) config.serverToken = tokenMatch[1];
      } catch {
        // ignore
      }
    }

    const isInstalled = fs.existsSync(agentExe);
    let isRunning = false;
    let pid: number | null = null;

    try {
      const result = execSync(
        'tasklist /FI "IMAGENAME eq HordeAgent.exe" /FO CSV /NH',
        { encoding: 'utf-8' },
      );
      if (result.includes('HordeAgent.exe')) {
        isRunning = true;
        const match = result.match(/(\d+)/);
        if (match) pid = parseInt(match[1], 10);
      }
    } catch {
      // ignore
    }

    return { isInstalled, isRunning, pid, config, workDir };
  });

  ipcMain.handle('start-horde-agent', async (): Promise<LaunchResult> => {
    const workDir = path.join(process.env.LOCALAPPDATA || '', 'HordeAgent');
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
        shell: false,
      });
      child.unref();
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('stop-horde-agent', async (): Promise<LaunchResult> => {
    try {
      execSync('taskkill /F /IM HordeAgent.exe', { stdio: 'ignore', windowsHide: true });
      return { success: true };
    } catch (e) {
      return { success: false, error: '停止失败: ' + (e instanceof Error ? e.message : String(e)) };
    }
  });
}

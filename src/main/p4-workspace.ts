import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { DEFAULT_P4_SERVER } from '../types/config';

const execFileAsync = promisify(execFile);

export interface P4ClientSpec {
  name: string;
  host: string;
  root: string;
}

export interface P4ConnectionParams {
  server: string;
  userName: string;
}

export function resolveProjectDir(uprojectPath: string): string {
  const trimmed = uprojectPath.trim();
  return trimmed.endsWith('.uproject') ? path.dirname(trimmed) : trimmed;
}

export interface P4SourceControlSettings {
  server?: string;
  userName?: string;
  workspace?: string;
}

// 从项目目录 Saved/Config/{Platform}/SourceControlSettings.ini 读取 P4 配置
// 匹配 PerforceSourceControl 段下的 Port/UserName/Workspace
export function readSourceControlSettings(projectDir: string): P4SourceControlSettings {
  const configDir = path.join(projectDir, 'Saved', 'Config');
  if (!fs.existsSync(configDir)) return {};

  // 遍历 Saved/Config 下的子目录（如 WindowsEditor、CrashReportClient 等）
  const subdirs = fs.readdirSync(configDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const subdir of subdirs) {
    const iniPath = path.join(configDir, subdir, 'SourceControlSettings.ini');
    if (!fs.existsSync(iniPath)) continue;

    try {
      const content = fs.readFileSync(iniPath, 'utf-8');
      let inPerforceSection = false;
      const result: P4SourceControlSettings = {};

      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        // 检测段头
        if (trimmed.startsWith('[')) {
          inPerforceSection = trimmed.toLowerCase().includes('perforcesourcecontrol');
          continue;
        }
        if (!inPerforceSection || !trimmed || trimmed.startsWith(';')) continue;

        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        const val = trimmed.substring(eqIdx + 1).trim();

        if (key === 'Port') result.server = val || undefined;
        else if (key === 'UserName') result.userName = val || undefined;
        else if (key === 'Workspace') result.workspace = val || undefined;
      }

      if (result.userName || result.workspace || result.server) return result;
    } catch {
      // 忽略读取错误，继续尝试其他目录
    }
  }

  return {};
}

export function getLocalP4Host(): string {
  return (process.env.P4HOST || os.hostname()).toLowerCase();
}

function normalizeP4Path(p: string): string {
  const normalized = path.resolve(p).replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function isProjectUnderClientRoot(clientRoot: string, projectDir: string): boolean {
  if (!clientRoot || clientRoot.toLowerCase() === 'null') return true;
  const rootNorm = normalizeP4Path(clientRoot);
  const projectNorm = normalizeP4Path(projectDir);
  return projectNorm.startsWith(rootNorm);
}

function matchesClientHost(clientHost: string, localHost: string): boolean {
  if (!clientHost) return true;
  return clientHost.toLowerCase() === localHost;
}

function parseP4ClientsZtag(output: string): P4ClientSpec[] {
  const clients: P4ClientSpec[] = [];
  // -Ztag 输出格式：每行 "... key value"，不同 client 之间用空行分隔
  let current: Partial<P4ClientSpec> = {};
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current.name) {
        clients.push({ name: current.name, host: current.host ?? '', root: current.root ?? '' });
      }
      current = {};
      continue;
    }
    // -Ztag 每行格式: "... key value"
    const m = trimmed.match(/^\.\.\.\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'client') current.name = val;
    else if (key === 'Host') current.host = val;
    else if (key === 'Root') current.root = val;
  }
  if (current.name) {
    clients.push({ name: current.name, host: current.host ?? '', root: current.root ?? '' });
  }
  return clients;
}

function buildP4Env(params: P4ConnectionParams & { workspace?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    P4PORT: params.server,
    P4USER: params.userName,
  };
  if (params.workspace) {
    env.P4CLIENT = params.workspace;
  }
  return env;
}

export async function listUserClients(server: string, userName: string): Promise<P4ClientSpec[]> {
  const env = buildP4Env({ server, userName });
  const { stdout } = await execFileAsync('p4', ['-Ztag', 'clients', '-u', userName], {
    env,
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseP4ClientsZtag(stdout);
}

export function filterWorkspacesLikeUE(
  clients: P4ClientSpec[],
  projectDir: string,
  localHost: string,
): P4ClientSpec[] {
  return clients.filter((client) => {
    if (!matchesClientHost(client.host, localHost)) return false;
    if (!isProjectUnderClientRoot(client.root, projectDir)) return false;
    return true;
  });
}

export async function listFilteredWorkspaces(
  server: string,
  userName: string,
  projectDir: string,
): Promise<{ localHost: string; totalCount: number; workspaces: P4ClientSpec[] }> {
  const port = server?.trim() || DEFAULT_P4_SERVER;
  const user = userName?.trim();
  if (!user) {
    throw new Error('未填写 P4 User Name');
  }

  const localHost = getLocalP4Host();
  const allClients = await listUserClients(port, user);
  const workspaces = filterWorkspacesLikeUE(allClients, projectDir, localHost);

  return { localHost, totalCount: allClients.length, workspaces };
}

export function buildP4EnvForSync(
  server: string,
  userName: string,
  workspace: string,
): NodeJS.ProcessEnv {
  return buildP4Env({
    server: server?.trim() || DEFAULT_P4_SERVER,
    userName: userName.trim(),
    workspace,
  });
}

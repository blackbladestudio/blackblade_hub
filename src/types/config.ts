export interface ToolEntry {
  label: string;
  path: string;
}

export interface MinioConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export interface LauncherConfig {
  installDir: string;
  /** S3 key prefix under which variants are organized, e.g. "ProjectZion/Win64" */
  prefix: string;
  /** Relative path to .exe inside the build directory, e.g. "Game/Binaries/Win64/Game.exe". Empty = auto-detect */
  exeRelativePath: string;
}

export interface AppConfig {
  gameExe: string;
  editorExe: string;
  tools: ToolEntry[];
  jenkins: string;
  horde: string;
  ugs: string;
  envScript: string;
  hordeAgentScript?: string;
  minio: MinioConfig;
  launcher: LauncherConfig;
}

export const DEFAULT_CONFIG: AppConfig = {
  gameExe: '',
  editorExe: '',
  tools: [],
  jenkins: '',
  horde: '',
  ugs: '',
  envScript: '',
  minio: {
    endpoint: 'http://10.248.15.20:9000',
    accessKey: '',
    secretKey: '',
    bucket: 'builds-client',
  },
  launcher: {
    installDir: '',
    prefix: '',
    exeRelativePath: '',
  },
};

export interface ToolEntry {
  label: string;
  path: string;
}

export interface MinioConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  maxWorkers?: number;
  /** 单个大文件的并发分片数，默认 8。单条连接跑不满内网带宽，分片并行是主要提速手段 */
  downloadSegments?: number;
}

export interface LauncherConfig {
  installDir: string;
  /** S3 key prefix under which variants are organized, e.g. "ProjectZion/Win64" */
  prefix: string;
  /** Relative path to .exe inside the build directory, e.g. "Game/Binaries/Win64/Game.exe". Empty = auto-detect */
  exeRelativePath: string;
  /** mc mirror exclude patterns — matching folders will be ignored by --remove (not synced, not deleted) */
  excludePatterns?: string[];
}

export interface PerforceConfig {
  /** Perforce server address, e.g. 10.248.15.25:1666 */
  server: string;
  userName: string;
  /** 从自动检测的下拉列表中选择；留空时同步操作会再次自动检测 */
  workspace: string;
}

export const DEFAULT_P4_SERVER = '10.248.15.25:1666';

export interface AppConfig {
  uprojectPath: string;
  perforce: PerforceConfig;
  tools: ToolEntry[];
  jenkins: string;
  horde: string;
  /** 工作室主页（studio_home）在浏览器中打开的 URL */
  studioHome: string;
  /** Studio Chat 入口 URL */
  studioChat: string;
  /** Hue Web 入口 URL */
  studioHue: string;
  envScript: string;
  hordeAgentScript?: string;
  minio: MinioConfig;
  launcher: LauncherConfig;
}

export const DEFAULT_CONFIG: AppConfig = {
  uprojectPath: '',
  perforce: {
    server: DEFAULT_P4_SERVER,
    userName: '',
    workspace: '',
  },
  tools: [],
  jenkins: '',
  horde: '',
  studioHome: '',
  studioChat: '',
  studioHue: '',
  envScript: '',
  minio: {
    endpoint: 'http://10.248.15.21:9000',
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

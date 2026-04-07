import type { AppConfig } from './config';
import type { LauncherManifest, LauncherState, DownloadProgress, GameVariant } from './launcher';

export interface ScriptResult {
  success: boolean;
  error?: string;
  exitCode?: number;
}

export interface LaunchResult {
  success: boolean;
  error?: string;
}

export interface HordeAgentStatus {
  isInstalled: boolean;
  isRunning: boolean;
  pid: number | null;
  config: {
    serverUrl?: string;
    serverToken?: string;
  };
  workDir: string;
}

export interface ScriptLogMessage {
  type: 'stdout' | 'stderr' | 'info' | 'error';
  msg: string;
}

export interface StudioHubAPI {
  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<boolean>;
  openUrl(url: string): Promise<boolean>;
  runScript(scriptPath: string): Promise<ScriptResult>;
  launchApp(appPath: string): Promise<LaunchResult>;
  selectFile(defaultPath?: string): Promise<string | null>;
  onScriptLog(callback: (msg: ScriptLogMessage) => void): void;
  getHordeAgentStatus(): Promise<HordeAgentStatus>;
  startHordeAgent(): Promise<LaunchResult>;
  stopHordeAgent(): Promise<LaunchResult>;
  winMinimize(): void;
  winMaximize(): void;
  winClose(): void;

  // Launcher
  launcherGetManifest(): Promise<{ data: LauncherManifest | null; error?: string }>;
  launcherGetState(): Promise<LauncherState>;
  launcherInstall(variant: GameVariant): Promise<LaunchResult>;
  launcherLaunch(variant: GameVariant): Promise<LaunchResult>;
  launcherUninstall(variant: GameVariant): Promise<LaunchResult>;
  launcherTestConnection(): Promise<LaunchResult>;
  launcherSelectInstallDir(): Promise<string | null>;
  onLauncherProgress(callback: (progress: DownloadProgress) => void): void;

  // UGS
  ugsCheckInstalled(): Promise<{ installed: boolean; path: string | null }>;
  ugsLaunch(): Promise<LaunchResult>;
  ugsOpenDownload(): Promise<void>;
  ugsDownloadAndInstall(): Promise<LaunchResult>;
}

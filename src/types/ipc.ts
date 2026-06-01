import type { AppConfig } from './config';
import type { LauncherManifest, LauncherState, DownloadProgress, GameVariant, BuildInfo } from './launcher';

export interface ScriptResult {
  success: boolean;
  error?: string;
  exitCode?: number;
}

export interface LaunchResult {
  success: boolean;
  error?: string;
  path?: string;
  pid?: number;
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

export interface BbCliStatus {
  isInstalled: boolean;
  installPath: string | null;
  version: string | null;
}

export interface CliOutputMessage {
  type: 'stdout' | 'stderr' | 'info' | 'error' | 'exit';
  msg: string;
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
  selectUproject(): Promise<string | null>;
  launchEditor(uprojectPath: string): Promise<LaunchResult>;
  onScriptLog(callback: (msg: ScriptLogMessage) => void): void;
  getHordeAgentStatus(): Promise<HordeAgentStatus>;
  startHordeAgent(): Promise<LaunchResult>;
  stopHordeAgent(): Promise<LaunchResult>;
  getBbCliStatus(): Promise<BbCliStatus>;
  runBbCliCommand(args: string[]): Promise<{ success: boolean; error?: string }>;
  onBbCliOutput(callback: (msg: CliOutputMessage) => void): void;
  winMinimize(): void;
  winMaximize(): void;
  winClose(): void;

  // Launcher
  launcherGetManifest(): Promise<{ data: LauncherManifest | null; error?: string }>;
  launcherGetState(): Promise<LauncherState>;
  launcherInstall(variant: GameVariant, objectKey?: string): Promise<LaunchResult>;
  launcherLaunch(variant: GameVariant): Promise<LaunchResult>;
  launcherUninstall(variant: GameVariant): Promise<LaunchResult>;
  launcherTestConnection(): Promise<LaunchResult>;
  launcherSelectInstallDir(): Promise<string | null>;
  launcherOpenInstallDir(variant: GameVariant): Promise<{ success: boolean; error?: string }>;
  launcherCheckRunning(variant: GameVariant): Promise<boolean>;
  launcherStop(variant: GameVariant): Promise<{ success: boolean; error?: string }>;
  launcherCheckUpdates(variant: GameVariant, objectKey?: string): Promise<{ hasUpdate: boolean; latestBuild?: BuildInfo; localVersion?: string; remoteVersion?: string; error?: string }>;
  launcherSyncVariant(variant: GameVariant, objectKey?: string): Promise<{ success: boolean; error?: string }>;
  onLauncherProgress(callback: (progress: DownloadProgress) => void): void;
  onLauncherUpdateAvailable(callback: (updates: Array<{ variant: GameVariant; localVersion: string | null; remoteVersion: string | null }>) => void): void;
  launcherForceCheckUpdates(variant?: GameVariant, objectKey?: string): Promise<{ data: Array<{
    variant: GameVariant;
    installed: boolean;
    remoteFileCount: number;
    localFileCount: number;
    missingFiles: number;
    sizeMismatchFiles: number;
    remoteVersion: string | null;
    localVersion: string | null;
    needsSync: boolean;
  }> | null; error?: string }>;
  launcherAbortInstall(): Promise<{ success: boolean }>;

  // Updater
  updaterCheck(): Promise<{ available: boolean; currentVersion: string; updateInfo?: { version: string; notes: string; url: string; date: string }; error?: string }>;
  updaterDownloadAndInstall(): Promise<{ success: boolean; error?: string }>;

  // UGS
  ugsCheckInstalled(): Promise<{ installed: boolean; path: string | null }>;
  ugsLaunch(): Promise<LaunchResult>;
  ugsOpenDownload(): Promise<void>;
  ugsDownloadAndInstall(): Promise<LaunchResult>;
}

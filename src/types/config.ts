export interface ToolEntry {
  label: string;
  path: string;
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
}

export const DEFAULT_CONFIG: AppConfig = {
  gameExe: '',
  editorExe: '',
  tools: [],
  jenkins: '',
  horde: '',
  ugs: '',
  envScript: '',
};

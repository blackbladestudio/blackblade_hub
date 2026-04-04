import { app } from 'electron';
import path from 'path';

/**
 * Resolve a path that may be relative to the app root.
 * In packaged builds, relative paths resolve against `process.resourcesPath`
 * (where extraResources are placed). In dev, they resolve against the project root.
 */
export function resolvePath(p: string): string {
  if (!p) return '';
  if (path.isAbsolute(p)) return p;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, p);
  }
  return path.join(app.getAppPath(), p);
}

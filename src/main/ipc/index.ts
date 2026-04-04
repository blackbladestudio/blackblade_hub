import { BrowserWindow } from 'electron';
import { registerConfigHandlers } from './config';
import { registerWindowHandlers } from './window';
import { registerLaunchHandlers } from './launch';
import { registerScriptHandlers } from './script';
import { registerHordeHandlers } from './horde';

export function registerAllHandlers(getMainWindow: () => BrowserWindow | null): void {
  registerConfigHandlers();
  registerWindowHandlers(getMainWindow);
  registerLaunchHandlers(getMainWindow);
  registerScriptHandlers(getMainWindow);
  registerHordeHandlers();
}

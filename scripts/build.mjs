import { execSync } from 'child_process';
import { cpSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const DIST = 'dist';

// Clean previous build
if (existsSync(DIST)) {
  rmSync(DIST, { recursive: true });
}

// 1. Compile main process + preload (TypeScript → CommonJS)
console.log('[build] Compiling TypeScript (main + preload)...');
execSync('npx tsc', { stdio: 'inherit' });

// 2. Bundle renderer TypeScript → single JS file
console.log('[build] Bundling renderer...');
mkdirSync(join(DIST, 'renderer'), { recursive: true });
execSync(
  'npx esbuild src/renderer/app.ts --bundle --outfile=dist/renderer/app.js --platform=browser --target=chrome120',
  { stdio: 'inherit' },
);

// 3. Copy static assets
console.log('[build] Copying static assets...');
cpSync('src/renderer/index.html', join(DIST, 'renderer', 'index.html'));
cpSync('src/renderer/styles.css', join(DIST, 'renderer', 'styles.css'));
cpSync('src/config.default.json', join(DIST, 'config.default.json'));

console.log('[build] Done!');

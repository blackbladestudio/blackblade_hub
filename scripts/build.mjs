import { execSync } from 'child_process';
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const DIST = 'dist';
const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
// 图标 base64（无前缀，build 时注入 HTML）
const iconBase64 = readFileSync('assets/icon.png').toString('base64');
const iconDataUri = `data:image/png;base64,${iconBase64}`;

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
let html = readFileSync('src/renderer/index.html', 'utf-8');
// 替换顶部图标：div → img（data URI 注入）
html = html.replace(
  '<div class="header-logo-mark"></div>',
  `<img class="header-logo-mark" src="${iconDataUri}" alt="BB" width="32" height="32">`
);
// 注入版本号（源文件保留 <!--VERSION--> 占位符，不碰中文内容）
const pkgVersion = pkg.version;
// 兼容 CRLF：用 \r?\n 匹配两种换行
html = html.replace(
  /<!--VERSION-->\r?\n  <span class="status-sep">·<\/span>\r?\n  <span>BLACKBLADE STUDIO<\/span>/,
  `<!--VERSION-->\r\n  <span class="status-sep">·</span>\r\n  <span>v${pkgVersion}</span>\r\n  <span class="status-sep">·</span>\r\n  <span>BLACKBLADE STUDIO</span>`
);
writeFileSync(join(DIST, 'renderer', 'index.html'), html, 'utf-8');
cpSync('src/renderer/styles.css', join(DIST, 'renderer', 'styles.css'));
cpSync('src/config.default.json', join(DIST, 'config.default.json'));
mkdirSync(join(DIST, 'assets'), { recursive: true });
cpSync('assets/icon.png', join(DIST, 'assets', 'icon.png'));

console.log('[build] Done!');

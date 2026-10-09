const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const quote = (value) => `'${value.replaceAll("'", "''")}'`;

function runInstaller({ type = 'exe', corrupt = false, exitCode = 0, installed = false, downloadOnly = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-assethive-test-'));
  const callPath = path.join(root, 'installer-call.json');
  const installerName = type === 'exe' ? 'AssetHive-2.2.1-setup-win64.exe' : 'AssetHive-2.2.1-Windows.msi';
  const wrapper = `
$env:LOCALAPPDATA = ${quote(root)}
function Invoke-RestMethod {
  [pscustomobject]@{ tag_name = 'v2.2.1'; draft = $false; prerelease = $false; assets = @(
    [pscustomobject]@{ name = '${installerName}'; browser_download_url = 'https://github.com/blackbladestudio/AssetHive/releases/download/v2.2.1/${installerName}' },
    [pscustomobject]@{ name = '${installerName}.sha256'; browser_download_url = 'https://github.com/blackbladestudio/AssetHive/releases/download/v2.2.1/${installerName}.sha256' }
  ) }
}
function Invoke-WebRequest {
  param($Uri, $Headers, $OutFile, [switch]$UseBasicParsing)
  if ($Uri.EndsWith('.sha256')) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes('installer'))).Replace('-', '').ToLowerInvariant()
    ${corrupt ? "$hash = '0' * 64" : ''}
    [IO.File]::WriteAllText($OutFile, "$hash  ${installerName}")
  } else { [IO.File]::WriteAllText($OutFile, 'installer') }
}
function Get-ItemProperty {
  param($Path, $ErrorAction)
  ${installed ? `if ($Path.StartsWith('HKCU:')) { [pscustomobject]@{ DisplayName = 'AssetHive 2.2.0'; Publisher = 'BlackBlade Studio'; InstallLocation = 'D:\\Artist Tools\\AssetHive' } }` : ''}
}
function Start-Process {
  param($FilePath, $ArgumentList, $WindowStyle, [switch]$Wait, [switch]$PassThru)
  [IO.File]::WriteAllText(${quote(callPath)}, (ConvertTo-Json @{ FilePath = $FilePath; Arguments = $ArgumentList; WindowStyle = $WindowStyle }))
  [pscustomobject]@{ ExitCode = ${exitCode} }
}
& ${quote(path.resolve(__dirname, '../tools/install_assethive.ps1'))} ${downloadOnly ? '-DownloadOnly' : ''}
`;
  const wrapperPath = path.join(root, 'run.ps1');
  fs.writeFileSync(wrapperPath, '\ufeff' + wrapper);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') },
  });
  return { ...result, call: fs.existsSync(callPath) ? JSON.parse(fs.readFileSync(callPath, 'utf8')) : null };
}

test('verifies the EXE checksum before launching Inno Setup in user mode', () => {
  const result = runInstaller();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.call.FilePath.endsWith('AssetHive-2.2.1-setup-win64.exe'));
  assert.match(result.call.Arguments, /\/VERYSILENT.*\/NORESTART.*\/CURRENTUSER/);
  assert.equal(result.call.WindowStyle, 'Hidden');
});

test('preserves the existing Inno installation directory', () => {
  const result = runInstaller({ installed: true });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.call.Arguments.includes('/DIR="D:\\Artist Tools\\AssetHive"'));
});

test('retains MSI support and accepts restart-required results', () => {
  const result = runInstaller({ type: 'msi', exitCode: 3010 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.call.FilePath, 'msiexec.exe');
  assert.match(result.stdout, /restart-required:/);
});

test('blocks installation on checksum mismatch', () => {
  const result = runInstaller({ corrupt: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.call, null);
  assert.match(result.stderr, /SHA-256 verification failed/);
});

test('reports installer failure without claiming success', () => {
  const result = runInstaller({ exitCode: 1 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exited with code 1/);
});

test('download-only verifies the package without executing it', () => {
  const result = runInstaller({ downloadOnly: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.call, null);
  assert.match(result.stdout, /download-only: verified/);
});

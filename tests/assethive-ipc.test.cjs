const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const EventEmitter = require('node:events');
const { promisify } = require('node:util');

function loadIpc(items, existing) {
  const service = require('../dist/main/services/assethive.js');
  const file = path.resolve(__dirname, '../dist/main/ipc/assethive.js');
  const exports = {};
  let launchedPath;
  const childProcess = {
    execFile(command, args, options, callback) {
      assert.ok(args.at(-1).includes('HKCU:'));
      callback(null, JSON.stringify(items), '');
    },
    spawn(executable, args, options) {
      launchedPath = executable;
      assert.equal(options.shell, false);
      return Object.assign(new EventEmitter(), { pid: 123, unref() {} });
    },
  };
  childProcess.execFile[promisify.custom] = async (command, args) => {
    assert.ok(args.at(-1).includes('HKCU:'));
    assert.ok(args.at(-1).includes('AssetHive('));
    assert.ok(args.at(-1).includes('\\d+\\.\\d+\\.\\d+'));
    return { stdout: JSON.stringify(items), stderr: '' };
  };
  const fakeFs = {
    existsSync: (candidate) => existing.includes(candidate),
    statSync(candidate) {
      if (!existing.includes(candidate)) throw new Error('missing');
      return { isFile: () => true };
    },
  };
  const customRequire = (name) => {
    if (name === 'electron') return {};
    if (name === 'child_process') return childProcess;
    if (name === 'fs') return fakeFs;
    if (name === '../services/assethive') return service;
    if (name === '../utils') return {};
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { exports, require: customRequire, process, console });
  return { exports, getLaunchedPath: () => launchedPath };
}

test('launches a registered user installation over an older machine installation', async () => {
  const installLocation = 'D:\\美术工具\\AssetHive';
  const executable = `${installLocation}\\AssetHive.exe`;
  const ipc = loadIpc([
    { DisplayVersion: '1.1.3', InstallLocation: 'C:\\Program Files\\AssetHive' },
    { DisplayVersion: '2.2.1', InstallLocation: installLocation },
  ], [executable, 'C:\\Program Files\\AssetHive\\AssetHive.exe']);
  const status = await ipc.exports.getAssetHiveStatus();
  assert.equal(status.state, 'ready');
  assert.equal(status.version, '2.2.1');
  assert.equal(status.installPath, executable);
  assert.equal((await ipc.exports.launchAssetHive()).success, true);
  assert.equal(ipc.getLaunchedPath(), executable);
});

test('reports a missing registered executable as damaged and refuses to launch', async () => {
  const ipc = loadIpc([{ DisplayVersion: '2.2.1', InstallLocation: 'D:\\AssetHive' }], []);
  assert.equal((await ipc.exports.getAssetHiveStatus()).state, 'damaged');
  assert.equal((await ipc.exports.launchAssetHive()).success, false);
  assert.equal(ipc.getLaunchedPath(), undefined);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const installer = Buffer.from('MZ installer fixture');
const digest = createHash('sha256').update(installer).digest('hex');
const release = {
  tag_name: 'v1.9.10', body: 'notes', assets: [{
    name: 'BlackBlade.Hub.Setup.1.9.10.exe', id: 42, size: installer.length, digest: 'sha256:' + digest,
  }],
};

async function load(t, fetch) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-updater-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const opened = [];
  const exports = {};
  const code = await fs.readFile(path.join(__dirname, '../dist/main/services/auto-updater.js'), 'utf8');
  vm.runInNewContext(code, {
    exports, fetch, AbortSignal, URL, Error, console,
    process: { env: { STUDIO_HUB_GITHUB_TOKEN: 'test-token' } },
    require: id => id === 'electron' ? {
      app: { getVersion: () => '1.9.9', getPath: () => temp },
      shell: { openPath: async file => { opened.push(file); return ''; } },
    } : require(id),
  });
  return { updater: exports, temp, opened };
}

test('detects a newer release and downloads without forwarding the API token', async t => {
  const requests = [];
  const { updater, opened } = await load(t, async (url, options) => {
    requests.push([String(url), options.headers]);
    if (requests.length === 1) return Response.json(release);
    if (requests.length === 2) return Response.redirect('https://release-assets.githubusercontent.com/installer');
    return new Response(installer);
  });

  const status = await updater.checkForUpdates();
  assert.equal(status.available, true);
  assert.equal(status.updateInfo.version, '1.9.10');
  await updater.downloadAndInstall(status);
  assert.match(requests[0][0], /\/releases\/latest$/);
  assert.match(requests[1][0], /\/releases\/assets\/42$/);
  assert.equal(requests[1][1].Authorization, 'Bearer test-token');
  assert.equal(requests[2][1], undefined);
  assert.deepEqual(await fs.readFile(opened[0]), installer);
});

test('rejects a same-size corrupted installer and removes the temporary download', async t => {
  const { updater, opened, temp } = await load(t, async () => new Response(Buffer.alloc(installer.length)));
  await assert.rejects(updater.downloadAndInstall({
    available: true, updateInfo: updater.parseRelease(release),
  }), /安装包校验失败/);
  assert.deepEqual(opened, []);
  assert.deepEqual(await fs.readdir(temp), []);
});

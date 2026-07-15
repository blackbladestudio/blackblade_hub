const assert = require('node:assert/strict');
const { app } = require('electron');

app.whenReady().then(async () => {
  const { getAssetHiveStatus, launchAssetHive } = require('../dist/main/ipc/assethive.js');
  const status = await getAssetHiveStatus();
  assert.equal(status.state, 'ready');
  assert.equal(status.version, '1.1.3');

  const launched = await launchAssetHive();
  assert.equal(launched.success, true);
  assert.ok(launched.pid);

  await new Promise((resolve) => setTimeout(resolve, 3000));
  try {
    process.kill(launched.pid);
  } catch {
    // The process may already have delegated to an existing instance.
  }
  process.stdout.write(`AssetHive IPC smoke passed: ${JSON.stringify(status)}\n`);
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});

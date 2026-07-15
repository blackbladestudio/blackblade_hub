const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  compareVersions,
  getExpectedAssetHiveExecutable,
  isTrustedAssetHivePath,
  normalizeVersion,
  parseChecksumFile,
  selectReleaseAssets,
} = require('../dist/main/services/assethive.js');

function release(overrides = {}) {
  const version = '1.2.3';
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/blackbladestudio/AssetHive/releases/tag/v${version}`,
    assets: [
      {
        name: `AssetHive-${version}-Windows.msi`,
        browser_download_url: `https://github.com/blackbladestudio/AssetHive/releases/download/v${version}/AssetHive-${version}-Windows.msi`,
      },
      {
        name: `AssetHive-${version}-Windows.msi.sha256`,
        browser_download_url: `https://github.com/blackbladestudio/AssetHive/releases/download/v${version}/AssetHive-${version}-Windows.msi.sha256`,
      },
    ],
    ...overrides,
  };
}

test('normalizes GitHub and MSI registry versions', () => {
  assert.equal(normalizeVersion('v1.2.3'), '1.2.3');
  assert.equal(normalizeVersion('1.2.3.0'), '1.2.3');
  assert.equal(normalizeVersion('1.2.3.4'), null);
});

test('compares semantic release versions', () => {
  assert.equal(compareVersions('1.2.3', '1.2.2'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', '2.0.0'), -1);
});

test('selects one exact stable release asset pair', () => {
  const selected = selectReleaseAssets(release());
  assert.equal(selected.version, '1.2.3');
  assert.equal(selected.msiName, 'AssetHive-1.2.3-Windows.msi');
});

test('rejects prereleases, duplicate assets and foreign URLs', () => {
  assert.throws(() => selectReleaseAssets(release({ prerelease: true })), /not stable/);
  const duplicate = release();
  duplicate.assets.push({ ...duplicate.assets[0] });
  assert.throws(() => selectReleaseAssets(duplicate), /one exact/);
  const foreign = release();
  foreign.assets[0].browser_download_url = 'https://example.com/AssetHive-1.2.3-Windows.msi';
  assert.throws(() => selectReleaseAssets(foreign), /not trusted/);
});

test('parses a checksum only for the expected filename', () => {
  const hash = 'a'.repeat(64);
  assert.equal(
    parseChecksumFile(`${hash}  AssetHive-1.2.3-Windows.msi`, 'AssetHive-1.2.3-Windows.msi'),
    hash,
  );
  assert.throws(
    () => parseChecksumFile(`${hash}  Other.msi`, 'AssetHive-1.2.3-Windows.msi'),
    /Invalid/,
  );
});

test('accepts only the fixed Program Files executable path', () => {
  const root = 'C:\\Program Files';
  const expected = getExpectedAssetHiveExecutable(root);
  assert.equal(isTrustedAssetHivePath(expected, root), true);
  assert.equal(isTrustedAssetHivePath(path.join(root, 'Other', 'AssetHive.exe'), root), false);
  assert.equal(isTrustedAssetHivePath(path.join(root, 'AssetHive', '..', 'Other.exe'), root), false);
});

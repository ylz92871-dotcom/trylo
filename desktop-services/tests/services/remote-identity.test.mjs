// node:test — remote identity store (migration spec §8.1.3 / arch §7.4).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REMOTE_IDENTITY_FILE,
  createIdentityStore,
  generatePairingToken,
  readIdentityFile,
  remoteIdentityFilePath,
} from '../../src/remote/identity.mjs';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function tempAppData(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trylo-remote-identity-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

test('remoteIdentityFilePath points at <app-data>/Trylo/remote/identity.json', () => {
  assert.equal(
    remoteIdentityFilePath('C:/app-data'),
    path.join('C:/app-data', 'Trylo', 'remote', 'identity.json'),
  );
  assert.equal(remoteIdentityFilePath(''), '');
  assert.equal(remoteIdentityFilePath('   '), '');
});

test('generatePairingToken produces a 32-byte base64url token', () => {
  const token = generatePairingToken();
  assert.equal(token.length >= 43, true); // 32 bytes -> 43 base64url chars
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  // Two draws differ (no accidental reuse).
  assert.notEqual(token, generatePairingToken());
});

test('loadOrCreate writes an isomorphic identity once and never rotates', async (t) => {
  const appData = await tempAppData(t);
  let calls = 0;
  const store = createIdentityStore({
    appDataDir: appData,
    generateToken: () => `tok-${'x'.repeat(40)}-${++calls}`,
    now: () => 1700000000000,
  });
  const first = await store.loadOrCreate();
  assert.equal(first.pairingToken, `tok-${'x'.repeat(40)}-1`);
  assert.equal(first.version, 1);
  assert.ok(first.deviceSeed.length > 0);

  // Second call loads the same file — no rotation, no second write.
  const second = await store.loadOrCreate();
  assert.equal(second.pairingToken, `tok-${'x'.repeat(40)}-1`);
  assert.equal(calls, 1);

  // The on-disk schema matches the legacy plugin shape.
  const raw = JSON.parse(await readFile(store.filePath, 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['deviceSeed', 'pairingToken', 'updatedAt', 'version']);
  assert.equal(raw.pairingToken, `tok-${'x'.repeat(40)}-1`);
});

test('loadOrCreate refuses to run without an app data dir', async () => {
  const store = createIdentityStore({ appDataDir: '' });
  await assert.rejects(() => store.loadOrCreate(), /app data dir is not configured/);
});

test('a corrupt identity file is treated as absent (regenerated)', async (t) => {
  const appData = await tempAppData(t);
  await mkdir(path.join(appData, 'Trylo', 'remote'), { recursive: true });
  await writeFile(path.join(appData, 'Trylo', 'remote', 'identity.json'), '{not json', 'utf8');
  const store = createIdentityStore({ appDataDir: appData });
  const identity = await store.loadOrCreate();
  assert.equal(identity.pairingToken.length >= 43, true);
});

test('importLegacy copies a legacy remote-identity.json once', async (t) => {
  const appData = await tempAppData(t);
  const legacyDir = await tempAppData(t);
  await writeFile(
    path.join(legacyDir, REMOTE_IDENTITY_FILE),
    JSON.stringify({ version: 1, pairingToken: 'legacy-token-32-bytes-xxxxxxxxxxxx', deviceSeed: 'MY-PC' }),
    'utf8',
  );

  const store = createIdentityStore({ appDataDir: appData });
  const result = await store.importLegacy({ legacyDir });
  assert.deepEqual(result, { imported: true, skipped: false });

  const identity = await store.loadOrCreate();
  assert.equal(identity.pairingToken, 'legacy-token-32-bytes-xxxxxxxxxxxx');
  assert.equal(identity.deviceSeed, 'MY-PC');

  // Second import is a no-op — the Desktop identity already exists.
  const again = await store.importLegacy({ legacyDir });
  assert.equal(again.imported, false);
  assert.equal(again.skipped, true);
});

test('importLegacy never overwrites an existing Desktop identity', async (t) => {
  const appData = await tempAppData(t);
  const legacyDir = await tempAppData(t);
  const store = createIdentityStore({ appDataDir: appData, generateToken: () => 'desktop-token-32-bytes-xxxxxxxxxxxxx' });
  await store.loadOrCreate();
  await writeFile(
    path.join(legacyDir, REMOTE_IDENTITY_FILE),
    JSON.stringify({ version: 1, pairingToken: 'legacy-token-32-bytes-xxxxxxxxxxxx', deviceSeed: 'OLD-PC' }),
    'utf8',
  );
  const result = await store.importLegacy({ legacyDir });
  assert.equal(result.imported, false);
  assert.equal((await store.loadOrCreate()).pairingToken, 'desktop-token-32-bytes-xxxxxxxxxxxxx');
});

test('readIdentityFile rejects tokens shorter than 32 chars', async (t) => {
  const appData = await tempAppData(t);
  const file = remoteIdentityFilePath(appData);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ pairingToken: 'short' }), 'utf8');
  assert.equal(await readIdentityFile(file), null);
});

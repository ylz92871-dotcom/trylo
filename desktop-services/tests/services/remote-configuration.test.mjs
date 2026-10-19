import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteConfiguration } from '../../src/remote/configuration.mjs';
import { createRemoteServices } from '../../src/remote/index.mjs';

async function fixture(t) {
  const appDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-connection-settings-'));
  t.after(() => fs.rm(appDataDir, { recursive: true, force: true }));
  const relay = { status: async () => ({ loggedIn: true, serverUrl: 'https://fixture.invalid' }) };
  return { appDataDir, relay, create: () => createRemoteConfiguration({ appDataDir, relay }) };
}
test('remote preferences survive a new host and a different renderer origin', async t => {
  const f = await fixture(t);
  await f.create().save({ connectionMode: 'server', relayUrl: 'https://fixture.invalid', enabled: true, port: 49380, password: 'not-a-preference' });
  const restored = await f.create().load({ connectionMode: 'tunnel', enabled: false });
  assert.equal(restored.connectionMode, 'server'); assert.equal(restored.enabled, true);
  const disk = await fs.readFile(path.join(f.appDataDir, 'Trylo/remote/connection-settings.json'), 'utf8');
  assert.ok(!disk.includes('not-a-preference')); assert.ok(!disk.includes('password'));
  await f.create().save({ ...restored, enabled: false });
  assert.equal((await f.create().load({ enabled: true })).enabled, false);
});
test('the service composition exposes configuration across host instances', async t => {
  const f = await fixture(t);
  const first = createRemoteServices({ appDataDir: f.appDataDir, seam: { tunnel: false } });
  await first.saveConfiguration({ enabled: true, connectionMode: 'server' });
  const second = createRemoteServices({ appDataDir: f.appDataDir, seam: { tunnel: false } });
  assert.equal((await second.loadConfiguration({ connectionMode: 'tunnel' })).connectionMode, 'server');
  await first.disable(); await second.disable();
});
test('old settings with no mode resume a saved server login; explicit tunnel remains authoritative', async t => {
  const f = await fixture(t);
  const restored = await f.create().load({ enabled: true });
  assert.equal(restored.connectionMode, 'server'); assert.equal(restored.relayUrl, 'https://fixture.invalid');
  await f.create().save({ connectionMode: 'tunnel', enabled: true });
  assert.equal((await f.create().load({ connectionMode: 'server' })).connectionMode, 'tunnel');
});
test('unreadable preferences are reported and never silently overwritten', async t => {
  const f = await fixture(t), c = f.create();
  await c.save({ connectionMode: 'server' });
  const file = path.join(f.appDataDir, 'Trylo/remote/connection-settings.json');
  await fs.writeFile(file, '{broken');
  await assert.rejects(c.load({ connectionMode: 'tunnel' }), /配置读取失败/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

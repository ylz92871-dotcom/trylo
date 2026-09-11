// node:test — remote tunnel service (migration spec §8.1.5 / arch §7.5).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTunnelService, TUNNEL_MODES } from '../../src/remote/tunnel-service.mjs';

const FAKE_NAMED_URL = 'https://remote.trylocode.me';

function fakeTunnelModule(overrides = {}) {
  return {
    DEFAULT_NAMED_TUNNEL_URL: FAKE_NAMED_URL,
    normalizePublicUrl: (value) => String(value || '').trim().replace(/\/+$/, ''),
    startCloudflareQuickTunnel: async ({ port }) => ({
      publicUrl: `https://quick-${port}.trycloudflare.com`,
      pid: 4242,
      logPath: '/tmp/cloudflared.log',
    }),
    probeTryloGateway: async (url) => url.startsWith('https://') && url.includes('trycloudflare'),
    ...overrides,
  };
}

test('TUNNEL_MODES covers named/quick/manual', () => {
  assert.deepEqual(TUNNEL_MODES, ['named', 'quick', 'manual']);
});

test('named mode returns the stable URL without spawning a process', async () => {
  const service = createTunnelService({ seam: { tunnel: fakeTunnelModule() } });
  const result = await service.start({ port: 49380, mode: 'named' });
  assert.equal(result.mode, 'named');
  assert.equal(result.publicUrl, FAKE_NAMED_URL);
  assert.equal(result.spawned, false);
  assert.equal(result.running, false);
  // Nothing to kill in named mode.
  await service.stop();
  assert.deepEqual(service.status(), { mode: 'off', running: false, publicUrl: '', pid: 0, logPath: '' });
});

test('manual mode uses the supplied https URL as-is and rejects non-https', async () => {
  const service = createTunnelService({ seam: { tunnel: fakeTunnelModule() } });
  const ok = await service.start({ mode: 'manual', publicUrl: 'https://example.com/tunnel/' });
  assert.equal(ok.publicUrl, 'https://example.com/tunnel');
  await assert.rejects(
    () => service.start({ mode: 'manual', publicUrl: 'http://insecure.example.com' }),
    /manual mode requires an https/,
  );
});

test('quick mode spawns cloudflared and stop() kills the spawned pid', async () => {
  const killed = [];
  const realKill = process.kill;
  process.kill = (pid) => {
    killed.push(pid);
    return true;
  };
  try {
    const service = createTunnelService({
      appDataDir: 'C:/app-data',
      seam: { tunnel: fakeTunnelModule() },
    });
    const result = await service.start({ port: 49380, mode: 'quick' });
    assert.equal(result.mode, 'quick');
    assert.equal(result.publicUrl, 'https://quick-49380.trycloudflare.com');
    assert.equal(result.pid, 4242);
    assert.equal(service.status().running, true);
    await service.stop();
    assert.deepEqual(killed, [4242]);
    assert.equal(service.status().running, false);
  } finally {
    process.kill = realKill;
  }
});

test('unknown mode falls back to named', async () => {
  const service = createTunnelService({ seam: { tunnel: fakeTunnelModule() } });
  const result = await service.start({ mode: 'weird' });
  assert.equal(result.mode, 'named');
});

test('probe delegates to the vendored module', async () => {
  const service = createTunnelService({ seam: { tunnel: fakeTunnelModule() } });
  assert.equal(await service.probe('https://abc.trycloudflare.com'), true);
  assert.equal(await service.probe('https://elsewhere.com'), false);
});

test('missing vendored module disables quick mode with a clear error', async () => {
  const service = createTunnelService({ seam: { tunnel: false } });
  await assert.rejects(
    () => service.start({ mode: 'quick', port: 49380 }),
    /vendored tunnel module unavailable/,
  );
  // named/manual still work without the module (they spawn nothing).
  const named = await service.start({ mode: 'named' });
  assert.equal(named.publicUrl, 'https://remote.trylocode.me');
});

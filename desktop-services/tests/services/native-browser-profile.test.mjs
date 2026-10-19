import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createToolProfileService } from '../../src/tooling/tool-profile-service.mjs';
import { createToolHealthService } from '../../src/tooling/tool-health-service.mjs';
import { PLAYWRIGHT_MANIFEST } from '../../src/tooling/manifests/playwright.mjs';
import { CHROME_DEVTOOLS_MANIFEST } from '../../src/tooling/manifests/chrome-devtools.mjs';

test('an embedded profile launches the service host rather than its callers entry script', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-embedded-profile-'));
  const manifest = PLAYWRIGHT_MANIFEST;
  const service = createToolProfileService({ storageRoot: root,
    catalog: { get: id => id === manifest.id ? manifest : undefined, list: () => [manifest] },
    health: { check: async () => ({ available: true }) }, packages: { resolve: async () => ({ executable: '/pinned/cli.js' }) },
    nativeBrowser: { configure: async () => ({ gate: 'http://127.0.0.1:12345/abc123', args: [] }) },
  });
  const result = await service.resolve({ surface: 'code', projectRoot: root, conversationId: 'embedded', computerUse: false });
  assert.equal(result.ok, true);
  const server = JSON.parse(fs.readFileSync(result.mcpConfigPath, 'utf8')).mcpServers['trylo-browser'];
  assert.equal(server.args[0], fileURLToPath(new URL('../../src/host.mjs', import.meta.url)));
  assert.equal(server.args[1], '--native-browser-mcp');
});

for (const [surface, profileId, manifest, flag] of [
  ['code', 'code.core.v1', PLAYWRIGHT_MANIFEST, '--cdp-endpoint'],
  ['work', 'work.core.v1', PLAYWRIGHT_MANIFEST, '--cdp-endpoint'],
  ['work', 'work.browser-debug.v1', CHROME_DEVTOOLS_MANIFEST, '--wsEndpoint'],
]) test(`${profileId} connects its pinned MCP to the same native browser through the whole-call gate`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-native-profile-'));
  const calls = [], gate = 'http://127.0.0.1:12345/test-token';
  const service = createToolProfileService({ storageRoot: root, hostEntrypoint: '/service/host.bundle.mjs',
    catalog: { get: id => id === manifest.id ? manifest : undefined, list: () => [manifest] },
    health: { check: async () => ({ available: true }) }, packages: { resolve: async () => ({ executable: '/pinned/cli.js', installDir: '/pinned' }) },
    nativeBrowser: { configure: async params => { calls.push(params); return { gate, args: [flag, flag === '--wsEndpoint' ? gate.replace('http:', 'ws:') + '/cdp/browser' : gate + '/'] }; } },
    browserObserver: { configure: () => { throw new Error('must never open a second browser'); } },
  });
  const result = await service.resolve({ surface, requestedProfileId: profileId, projectRoot: root, conversationId: 'same-page' });
  assert.equal(result.ok, true);
  const server = JSON.parse(fs.readFileSync(result.mcpConfigPath, 'utf8')).mcpServers[manifest.mcp.serverName];
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args.slice(0, 4), ['/service/host.bundle.mjs', '--native-browser-mcp', gate, '/pinned/cli.js']);
  assert.ok(server.args.includes(flag)); assert.ok(server.args.includes(flag === '--wsEndpoint' ? gate.replace('http:', 'ws:') + '/cdp/browser' : gate + '/'));
  assert.equal(server.args.includes('--isolated'), false); assert.equal(server.args.includes('--headless'), false);
  assert.deepEqual(calls, [{ packageId: manifest.id, projectRoot: root, conversationId: 'same-page' }]);
});

test('native startup failure is an unavailable capability and never opens a hidden fallback browser', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-native-failure-'));
  const service = createToolProfileService({ storageRoot: root,
    catalog: { get: id => id === 'playwright' ? PLAYWRIGHT_MANIFEST : undefined, list: () => [PLAYWRIGHT_MANIFEST] },
    health: { check: async () => ({ available: true }) }, packages: { resolve: async () => ({ executable: '/pinned/cli.js' }) },
    nativeBrowser: { configure: async () => { throw new Error('WebView2 startup failed'); } },
    browserObserver: { configure: () => { throw new Error('fallback was used'); } },
  });
  const result = await service.resolve({ surface: 'code', projectRoot: root, conversationId: 'one' });
  assert.ok(result.unavailableCapabilities.some(item => item.reasonCode === 'native_browser_unavailable' && /WebView2/.test(item.userMessage)));
  const config = result.mcpConfigPath ? JSON.parse(fs.readFileSync(result.mcpConfigPath, 'utf8')) : { mcpServers: {} };
  assert.equal(config.mcpServers['trylo-playwright'], undefined);
});

test('native mode checks the pinned MCP version without requiring an unused separate Chromium install', async () => {
  let probedChromium = false;
  const packages = { resolve: async () => ({ state: 'installed', executable: '/pinned/cli.js' }) };
  const options = { packages, browserBackend: 'native', probeCondition: () => { probedChromium = true; return { ok: false }; } };
  const healthy = await createToolHealthService({ ...options, probe: async () => 'Version 0.0.79' }).check(PLAYWRIGHT_MANIFEST, { deep: true });
  assert.equal(healthy.available, true); assert.equal(probedChromium, false);
  const wrong = await createToolHealthService({ ...options, probe: async () => 'Version 9.9.9' }).check(PLAYWRIGHT_MANIFEST, { deep: true });
  assert.equal(wrong.available, false); assert.equal(wrong.state, 'version-mismatch');
});

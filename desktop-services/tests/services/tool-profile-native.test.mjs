import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createToolProfileService } from '../../src/tooling/tool-profile-service.mjs';
import { MACOS_COMPUTER_EXECUTABLE, MACOS_COMPUTER_SERVER } from '../../src/tooling/macos-computer-contract.mjs';

test('Code and Work supply immutable native registries with canonical stdio and remote entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trylo-native-profile-'));
  const definitions = {
    local: { command: 'node', args: ['server.js'], env: { LOCAL: 'yes' } },
    remote: { type: 'http', url: 'https://example.test/mcp', headers: {} },
    events: { type: 'sse', url: 'https://example.test/sse', headers: { Authorization: 'fixture' } },
  };
  const service = createToolProfileService({ storageRoot: root,
    catalog: { get: () => undefined, list: () => [] },
    hermes: { mcpArgs: () => ({ ok: true, arg: ['--mcp-config', JSON.stringify({ mcpServers: definitions })] }) },
  });
  const code = await service.resolve({ surface: 'code', projectRoot: root, conversationId: 'code' });
  const work = await service.resolve({ surface: 'work', projectRoot: root, conversationId: 'work' });
  assert.equal(code.ok, true); assert.equal(work.ok, true);
  assert.equal(code.spawnEnv.TRYLO_MCP_RUNTIME_MODE, 'overlay');
  assert.equal(work.spawnEnv.TRYLO_MCP_RUNTIME_MODE, 'exclusive');
  const document = JSON.parse(readFileSync(code.spawnEnv.TRYLO_MCP_RUNTIME_REGISTRY, 'utf8'));
  assert.deepEqual(document.servers, [
    { name: 'local', transport: 'stdio', command: 'node', args: ['server.js'], env: { LOCAL: 'yes' }, enabled: true },
    { name: 'remote', transport: 'http', url: 'https://example.test/mcp', enabled: true },
    { name: 'events', transport: 'sse', url: 'https://example.test/sse', headers: { Authorization: 'fixture' }, enabled: true },
  ]);
  assert.equal(document.formatVersion, 1);
  assert.equal(document.checksum, createHash('sha256').update(service.stableStringify(document.servers)).digest('hex'));
  assert.equal(work.spawnEnv.TRYLO_MCP_RUNTIME_REGISTRY, code.spawnEnv.TRYLO_MCP_RUNTIME_REGISTRY);
});

test('native macOS computer tools mount in both profiles only when enabled', async t => {
  const root = mkdtempSync(join(tmpdir(), 'trylo-macos-profile-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const services = join(root, 'Resources', 'desktop-services');
  const executable = join(services, MACOS_COMPUTER_EXECUTABLE);
  const options = { storageRoot: root, hostEntrypoint: join(services, 'dist', 'host.bundle.mjs'),
    catalog: { get: () => undefined, list: () => [] } };
  const service = createToolProfileService({ ...options, macosComputerEnabled: true });
  const missing = await service.resolve({ surface: 'work' });
  assert.equal(missing.ok, true);
  assert.ok(missing.unavailableCapabilities.some(item => item.reasonCode === 'macos_computer_unavailable'));

  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, 'fixture', { mode: 0o755 });
  for (const surface of ['code', 'work']) {
    const profile = await service.resolve({ surface });
    assert.equal(profile.ok, true);
    assert.deepEqual(profile.serverNames, [MACOS_COMPUTER_SERVER]);
    assert.equal(profile.unavailableCapabilities.some(item => item.id === 'windows-mcp'), false);
    const registry = JSON.parse(readFileSync(profile.spawnEnv.TRYLO_MCP_RUNTIME_REGISTRY, 'utf8'));
    assert.equal(registry.servers[0].command, executable);
    const settings = JSON.parse(readFileSync(profile.permissionSettingsPath, 'utf8'));
    assert.ok(settings.permissions.ask.includes('mcp__trylo-macos__*'));
    const disabled = await service.resolve({ surface, computerUse: false });
    assert.equal(disabled.serverNames.includes(MACOS_COMPUTER_SERVER), false);
  }
  const defaults = await createToolProfileService(options).resolve({ surface: 'code' });
  assert.equal(defaults.serverNames.includes(MACOS_COMPUTER_SERVER), false);
});

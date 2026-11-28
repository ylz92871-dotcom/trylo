import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { workspacePath } from '../../../scripts/workspace-paths.mjs';
import { createToolPackageManager, loadRepositoryToolRegistry } from '../../src/tooling/tool-package-manager.mjs';
import { createToolHealthService } from '../../src/tooling/tool-health-service.mjs';
import { OFFICECLI_MANIFEST } from '../../src/tooling/manifests/officecli.mjs';
import { WINDOWS_MCP_MANIFEST } from '../../src/tooling/manifests/windows-mcp.mjs';
import { createToolProfileService } from '../../src/tooling/tool-profile-service.mjs';

async function fixture() {
  const parent = workspacePath('cache/tests/builtin-tools');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-'));
  const executable = path.join(root, 'office.exe');
  const bytes = Buffer.from('test-binary');
  await fs.writeFile(executable, bytes);
  const registry = path.join(root, 'tool-sources.json');
  const entries = { officecli: { policy: 'bundled', entry: 'office.exe', version: '1.0.153', args: [], sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
  const save = async () => fs.writeFile(registry, JSON.stringify({ schemaVersion: 1, tools: entries }));
  await save();
  const packages = createToolPackageManager({ enableRepositoryTools: true, localToolRegistryPath: registry,
    installRoot: path.join(root, 'installs'), overrides: {}, catalog: { get: id => id === 'officecli' ? OFFICECLI_MANIFEST : WINDOWS_MCP_MANIFEST },
    download: async () => { throw new Error('Network must not be called'); } });
  return { root, executable, entries, save, registry, packages };
}

test('bundled artifacts relocate, verify their digest and use their shipped version', async () => {
  const f = await fixture();
  const moved = f.root + '-relocated';
  await fs.rename(f.root, moved);
  const packages = createToolPackageManager({ enableRepositoryTools: true, localToolRegistryPath: path.join(moved, 'tool-sources.json'), overrides: {} });
  const resolved = await packages.resolve(OFFICECLI_MANIFEST);
  assert.equal(resolved.executable, path.join(moved, 'office.exe'));
  assert.equal(resolved.builtIn, true);
  const health = createToolHealthService({ packages, probe: async () => '1.0.153' });
  assert.equal((await health.check(OFFICECLI_MANIFEST)).available, true);
  await fs.appendFile(resolved.executable, 'tampered');
  assert.equal((await health.check(OFFICECLI_MANIFEST)).state, 'hash-mismatch');
});

test('missing built-ins and install/uninstall/browser requests never fall through to downloads', async () => {
  const f = await fixture();
  await fs.unlink(f.executable);
  assert.equal((await f.packages.resolve(OFFICECLI_MANIFEST)).executable, null);
  for (const method of ['install', 'uninstall', 'installBrowser']) {
    assert.equal((await f.packages[method]({ id: 'officecli' })).reasonCode, 'builtin_tool');
  }
});

test('explicit user paths retain priority over bundled artifacts', async () => {
  const f = await fixture();
  const custom = path.join(f.root, 'custom.exe');
  await fs.writeFile(custom, 'custom');
  const packages = createToolPackageManager({ enableRepositoryTools: true, localToolRegistryPath: f.registry, overrides: { officecli: custom } });
  assert.equal((await packages.resolve(OFFICECLI_MANIFEST)).executable, custom);
});

test('an inherited missing core path cannot shadow the shipped runtime, while an explicit override stays authoritative', async () => {
  const f = await fixture();
  const oldEnv = process.env.TRYLO_TOOL_PACKAGE_OVERRIDES;
  const missing = path.join(f.root, 'retired-toolchain', 'office.exe');
  process.env.TRYLO_TOOL_PACKAGE_OVERRIDES = JSON.stringify({ officecli: missing });
  try {
    const packages = createToolPackageManager({ enableRepositoryTools: true, localToolRegistryPath: f.registry });
    assert.equal((await packages.resolve(OFFICECLI_MANIFEST)).executable, f.executable);
    const explicit = createToolPackageManager({ enableRepositoryTools: true, localToolRegistryPath: f.registry, overrides: { officecli: missing } });
    assert.equal((await explicit.resolve(OFFICECLI_MANIFEST)).executable, null);
  } finally {
    if (oldEnv === undefined) delete process.env.TRYLO_TOOL_PACKAGE_OVERRIDES;
    else process.env.TRYLO_TOOL_PACKAGE_OVERRIDES = oldEnv;
  }
});

test('registry rejects path escapes and malformed bundle digests', async () => {
  const f = await fixture();
  f.entries.officecli.entry = '../outside.exe';
  await f.save();
  assert.match(loadRepositoryToolRegistry(f.registry).problems[0], /escapes/);
  f.entries.officecli.entry = 'office.exe';
  f.entries.officecli.sha256 = 'invalid';
  await f.save();
  assert.match(loadRepositoryToolRegistry(f.registry).problems[0], /sha256/);
});

test('portable Python launch arguments are included in the actual MCP registry', async () => {
  const parent = workspacePath('cache/tests/builtin-profiles');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-'));
  const packages = { resolve: async () => ({ executable: path.join(root, 'python.exe'), installDir: root, state: 'installed', argsPrefix: ['-B', '-m', 'windows_mcp'] }) };
  const profiles = createToolProfileService({ platform: 'win32', profilesRoot: root, storageRoot: root, packages,
    catalog: { get: id => id === 'windows-mcp' ? WINDOWS_MCP_MANIFEST : null, list: () => [WINDOWS_MCP_MANIFEST] },
    health: { check: async manifest => ({ id: manifest.id, available: true }) },
    hermes: { mcpArgs: () => ({ ok: true, arg: [], warning: null }) } });
  const result = await profiles.resolve({ surface: 'work', projectKey: 'p', projectRoot: root, conversationId: 'c', permissionLevel: 'workspace_write' });
  assert.equal(result.ok, true);
  const config = JSON.parse(await fs.readFile(result.mcpConfigPath, 'utf8'));
  assert.deepEqual(config.mcpServers['trylo-windows'].args.slice(0, 3), ['-B', '-m', 'windows_mcp']);
});

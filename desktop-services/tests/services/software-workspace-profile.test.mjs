import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { temporaryPath } from '../../../scripts/workspace-paths.mjs';
import { createToolProfileService } from '../../src/tooling/tool-profile-service.mjs';
import { SOFTWARE_NAMES } from '../../src/tooling/software-workspace-contract.mjs';
import { createToolCatalog } from '../../src/tooling/tool-catalog.mjs';

test('Code/Work mount the same built-in tools automatically; explicit disable removes them', async () => {
  const root = temporaryPath('software-workspace-profile');
  await mkdir(root, { recursive: true });
  let configured = 0;
  const service = createToolProfileService({ storageRoot: root, hostEntrypoint: 'host.mjs',
    catalog: { get: () => undefined, list: () => [] },
    softwareWorkspace: { async configure() { configured++; return { gate: 'http://127.0.0.1:12345/capability' }; } },
  });
  for (const surface of ['code', 'work']) {
    const result = await service.resolve({ surface, projectRoot: root, conversationId: surface });
    assert.equal(result.ok, true);
    const registry = JSON.parse(await readFile(result.spawnEnv.TRYLO_MCP_RUNTIME_REGISTRY, 'utf8'));
    const server = registry.servers.find(item => item.name === 'trylo-software');
    assert.deepEqual(server.args, ['host.mjs', '--software-workspace-mcp', 'http://127.0.0.1:12345/capability']);
    assert.deepEqual(result.packageHealth.find(row => row.id === 'software-workspace').expectedTools, SOFTWARE_NAMES);
    const disabled = await service.resolve({ surface, projectRoot: root, conversationId: `${surface}-disabled`, computerUse: false });
    const disabledRegistry = JSON.parse(await readFile(disabled.spawnEnv.TRYLO_MCP_RUNTIME_REGISTRY, 'utf8'));
    assert.ok(!disabledRegistry.servers.some(item => item.name === 'trylo-software'));
  }
  assert.equal(configured, 2);
});

test('CAD API definitions keep their schemas and approval identity while their process placement changes', async () => {
  const root = temporaryPath('software-cad-profile');
  await mkdir(root, { recursive: true });
  const definitions = [];
  const service = createToolProfileService({ storageRoot: root, hostEntrypoint: 'host.mjs', catalog: createToolCatalog(),
    health: { async check(manifest) { return { id: manifest.id, available: true }; } },
    packages: { async resolve(manifest) { return { executable: `C:/tools/${manifest.id}/tool.exe`, installDir: `C:/tools/${manifest.id}`, version: manifest.version }; } },
    softwareWorkspace: { async configure(params) { definitions.push(params); return { gate: 'http://127.0.0.1:12345/scope' }; } },
  });
  const result = await service.resolve({ surface: 'work', requestedProfileId: 'work.cad.v1', projectRoot: root, conversationId: 'cad' });
  assert.equal(result.ok, true);
  const registry = JSON.parse(await readFile(result.spawnEnv.TRYLO_MCP_RUNTIME_REGISTRY, 'utf8'));
  for (const [packageId, name] of [['solidworks-mcp', 'trylo-solidworks'], ['autocad-mcp', 'trylo-autocad']]) {
    assert.deepEqual(registry.servers.find(server => server.name === name).args, ['host.mjs', '--software-workspace-mcp', 'http://127.0.0.1:12345/scope', packageId]);
    assert.ok(definitions.some(item => item.packageId === packageId && item.server.command.endsWith(`${packageId}/tool.exe`)));
  }
  // The {installDir} argv token still expands inside the relayed spec (§6.2):
  // placement changes transport, not the pinned source entry resolution.
  const solidworks = definitions.find(item => item.packageId === 'solidworks-mcp');
  assert.ok(solidworks?.server.args.includes('C:/tools/solidworks-mcp/mcp-server/server.py'));
});

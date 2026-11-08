import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { temporaryPath } from '../../../scripts/workspace-paths.mjs';
import { createToolProfileService } from '../../src/tooling/tool-profile-service.mjs';

test('Code and Work inject the built-in preview server without package install or computer control', async t => {
  const scratch = temporaryPath('model-preview-profile');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createToolProfileService({ storageRoot: root, hostEntrypoint: 'built-in-host.mjs',
    catalog: { get: () => undefined, list: () => [] },
    modelPreview: { async configure({ conversationId }) { return { scope: conversationId, gate: `http://127.0.0.1:12345/${conversationId}` }; } },
  });
  for (const surface of ['code', 'work']) {
    const result = await service.resolve({ surface, projectRoot: root, conversationId: surface, computerUse: false });
    assert.equal(result.ok, true);
    const registry = JSON.parse(await readFile(result.spawnEnv.TRYLO_MCP_RUNTIME_REGISTRY, 'utf8'));
    const server = registry.servers.find(server => server.name === 'trylo-preview');
    assert.ok(server);
    assert.deepEqual(server.args, ['built-in-host.mjs', '--model-preview-mcp', `http://127.0.0.1:12345/${surface}`]);
    const health = result.packageHealth.find(row => row.id === 'model-preview');
    assert.equal(health?.builtIn, true);
    assert.equal(health?.available, true);
    assert.deepEqual(health?.expectedTools, ['preview_open', 'preview_view', 'preview_snapshot', 'preview_close']);
    const settings = JSON.parse(await readFile(result.permissionSettingsPath, 'utf8'));
    assert.ok(settings.permissions.ask.includes('mcp__trylo-preview__*'));
  }
});

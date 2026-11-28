import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { temporaryPath } from '../../../scripts/workspace-paths.mjs';
import { createToolProfileService } from '../../src/tooling/tool-profile-service.mjs';
import { CORE_TOOL_RUNTIME_REVISION } from '../../src/tooling/tool-catalog.mjs';
import { OFFICECLI_MANIFEST } from '../../src/tooling/manifests/officecli.mjs';
import { PLAYWRIGHT_MANIFEST } from '../../src/tooling/manifests/playwright.mjs';
import { WINDOWS_MCP_MANIFEST } from '../../src/tooling/manifests/windows-mcp.mjs';

for (const phase of ['health', 'resolution', 'browser-observer', 'runtime-directory', 'runtime-change', 'native-startup']) {
  test(`a ${phase} exception leaves the other enabled packages mounted`, async t => {
    const parent = temporaryPath('desktop-services-tests');
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'profile-failure-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const manifests = [OFFICECLI_MANIFEST, PLAYWRIGHT_MANIFEST, WINDOWS_MCP_MANIFEST];
    const failedId = ['browser-observer', 'runtime-directory', 'native-startup'].includes(phase) ? 'playwright' : 'officecli';
    if (phase === 'runtime-directory') {
      await fs.mkdir(path.join(root, '.trylo/runtime'), { recursive: true });
      await fs.writeFile(path.join(root, '.trylo/runtime/browser'), 'blocked browser directory');
    }
    const service = createToolProfileService({
      platform: 'win32', // These fixtures exercise the Windows computer package on every host.
      storageRoot: root,
      catalog: { get: id => manifests.find(item => item.id === id), list: () => manifests },
      health: { check: async manifest => {
        if (phase === 'health' && manifest.id === failedId) throw new Error('injected health failure');
        return { id: manifest.id, available: true,
          ...(phase === 'runtime-change' && manifest.id === failedId ? { runtimeIdentity: 'previous-runtime' } : {}) };
      } },
      packages: { resolve: async manifest => {
        if (phase === 'resolution' && manifest.id === failedId) throw new Error('injected resolution failure');
        return { state: 'installed', executable: path.join(root, manifest.id), installDir: root };
      } },
      browserObserver: { configure: async () => {
        if (phase === 'browser-observer') throw new Error('injected observer failure');
        return [];
      } },
      ...(phase === 'native-startup' ? { nativeBrowser: { configure: async () => { throw new Error('injected native startup failure'); } } } : {}),
    });

    const resolved = await service.resolve({ surface: 'code', projectRoot: root, conversationId: 'isolated' });
    assert.equal(resolved.ok, true);
    const failure = resolved.unavailableCapabilities.find(item => item.id === failedId);
    assert.equal(failure?.reasonCode, phase === 'runtime-change' ? 'runtime_changed'
      : phase === 'native-startup' ? 'native_browser_unavailable' : 'package_resolution_failed');
    assert.match(failure.detail, phase === 'runtime-directory' ? /EEXIST|ENOTDIR/
      : phase === 'runtime-change' ? /runtime changed/ : /injected/);
    const servers = JSON.parse(await fs.readFile(resolved.mcpConfigPath, 'utf8')).mcpServers;
    const registry = JSON.parse(await fs.readFile(resolved.spawnEnv.TRYLO_MCP_RUNTIME_REGISTRY, 'utf8'));
    assert.deepEqual(Object.keys(servers).sort(), manifests.filter(item => item.id !== failedId).map(item => item.mcp.serverName).sort());
    assert.deepEqual(registry.servers.map(item => item.name).sort(), Object.keys(servers).sort());
    assert.ok(registry.servers.every(item => item.env.TRYLO_CORE_TOOL_RUNTIME_REVISION === String(CORE_TOOL_RUNTIME_REVISION)));
    assert.equal(resolved.packageHealth.find(item => item.id === failedId)?.available, false);
    assert.equal(resolved.packageHealth.filter(item => item.id === failedId).length, 1);
  });
}

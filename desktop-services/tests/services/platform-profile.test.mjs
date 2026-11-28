import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { temporaryPath } from '../../../scripts/workspace-paths.mjs';
import path from 'node:path';
import { test } from 'node:test';
import { builtinToolIdsForPlatform } from '../../src/tooling/tool-package-manager.mjs';
import { createToolProfileService } from '../../src/tooling/tool-profile-service.mjs';
import { createToolingServices } from '../../src/tooling/index.mjs';

const scratch = temporaryPath('platform-profile');
mkdirSync(scratch, { recursive: true });

for (const [platform, expected] of [['win32', 'windows-mcp'], ['darwin', 'macos-computer'], ['linux', 'linux-mcp']]) {
  for (const surface of ['code', 'work']) {
    test(surface + ' resolves the local computer package on ' + platform, async () => {
      const root = mkdtempSync(path.join(scratch, 'trylo-platform-profile-'));
      const requested = [];
      try {
        const service = createToolProfileService({
          platform, storageRoot: root,
          catalog: { get(id) { requested.push(id); return undefined; }, list: () => [] },
        });
        const result = await service.resolve({ surface, projectRoot: root, conversationId: surface });
        assert.equal(result.ok, true);
        assert.ok(requested.includes(expected));
        if (platform !== 'win32') assert.ok(!requested.includes('windows-mcp'));
        assert.ok(result.unavailableCapabilities.some(item => item.id === expected && item.reasonCode === 'not_in_catalog'));
        requested.length = 0;
        const disabled = await service.resolve({ surface, computerUse: false, projectRoot: root, conversationId: surface });
        assert.equal(disabled.ok, true);
        assert.ok(!requested.includes(expected));
        assert.ok(!disabled.unavailableCapabilities.some(item => item.id === expected));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test('an unknown OS keeps the conversation usable without selecting Windows tools', async () => {
  const root = mkdtempSync(path.join(scratch, 'trylo-platform-unknown-'));
  try {
    const requested = [];
    const service = createToolProfileService({ platform: 'unknown', storageRoot: root,
      catalog: { get(id) { requested.push(id); return undefined; }, list: () => [] } });
    const result = await service.resolve({ surface: 'code', projectRoot: root, conversationId: 'unknown' });
    assert.equal(result.ok, true);
    assert.ok(!requested.includes('windows-mcp'));
    assert.ok(result.unavailableCapabilities.some(item => item.reasonCode === 'unsupported_platform'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundled package ownership follows the selected OS and excludes other computer adapters", () => {
  assert.ok(builtinToolIdsForPlatform("win32").includes("windows-mcp"));
  const mac = builtinToolIdsForPlatform("darwin");
  assert.ok(mac.includes("macos-computer"));
  assert.ok(!mac.includes("windows-mcp"));
  const linux = builtinToolIdsForPlatform("linux");
  assert.ok(linux.includes("linux-mcp"));
  assert.ok(!linux.includes("windows-mcp"));
  assert.deepEqual(builtinToolIdsForPlatform("unknown"), ["officecli", "playwright", "chrome-devtools"]);
});

for (const target of ['win32-x64', 'darwin-arm64', 'linux-x64']) {
  test('service composition advertises the Win32 software workspace only on Windows: ' + target, async t => {
    const root = mkdtempSync(path.join(scratch, 'trylo-software-platform-'));
    const tooling = createToolingServices({ appDataDir: root, sidecarsDir: root, seam: {
      target, manifests: [], installRoot: path.join(root, 'packages'), profilesRoot: path.join(root, 'profiles'),
      hermes: { mcpArgs: () => ({ ok: true, arg: [] }) },
    } });
    t.after(async () => { await tooling.dispose(); await new Promise(resolve => setImmediate(resolve)); rmSync(root, { recursive: true, force: true }); });
    for (const surface of ['code', 'work']) {
      const profile = await tooling.resolveProfile({ surface, projectRoot: root, conversationId: surface });
      assert.equal(profile.ok, true);
      assert.equal(profile.serverNames.includes('trylo-software'), target.startsWith('win32-'));
      assert.equal(profile.packageHealth.some(item => item.id === 'software-workspace' && item.available), target.startsWith('win32-'));
    }
  });
}

// Service integration checks require desktop-services' locked dependencies.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { temporaryPath } from '../../../scripts/workspace-paths.mjs';
import { createToolingServices } from '../../src/tooling/index.mjs';

const scratch = temporaryPath('tooling-platform-composition');
mkdirSync(scratch, { recursive: true });

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

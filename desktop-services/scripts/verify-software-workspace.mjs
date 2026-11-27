// Local native acceptance. Launches only owned applications, no model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSoftwareWorkspace, softwareRuntimeEntry } from '../src/tooling/software-workspace-service.mjs';
import { createToolCatalog } from '../src/tooling/tool-catalog.mjs';
import { createToolPackageManager } from '../src/tooling/tool-package-manager.mjs';
import { resolveComputerPreviewPython } from '../src/tooling/computer-control/windows/computer-preview-stream.mjs';
import { workspacePath } from '../../scripts/workspace-paths.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = workspacePath('tasks', 'software-workspace-implementation-20261110', `native-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const catalog = createToolCatalog();
const packages = createToolPackageManager({ catalog, storageRoot: path.join(output, 'packages'), enableRepositoryTools: true });
const executable = await resolveComputerPreviewPython({ catalog, packages });
assert.ok(executable, 'managed built-in Python');
const events = [];
const service = createSoftwareWorkspace({ storageRoot: output, emit: (topic, value) => events.push({ topic, value }),
  resolveRuntime: async () => ({ executable, entry: process.argv.includes('--source')
    ? path.join(root, 'desktop-services/toolchain/software-workspace/controller.py') : await softwareRuntimeEntry() }) });
const scope = { projectRoot: output, conversationId: 'native-software-acceptance' };
const command = (operation, input) => service.command({ ...scope, operation, input });
const selected = process.argv.find(value => value.startsWith('--application='))?.split('=')[1];
try {
  const state = await command('status');
  assert.ok(state.installed.some(app => app.kind === 'solidworks'));
  const target = selected ? state.installed.find(app => app.kind === selected) : { path: executable, args: ['-B', path.join(root, 'desktop-services/tests/fixtures/software-workspace.py')] };
  assert.ok(target, 'application discovery');
  await command('open', { path: target.path, ...(target.args ? { args: target.args } : {}) });
  let observed;
  const deadline = Date.now() + 120000; // Harness observation budget, not product lifetime.
  do {
    observed = await command('status');
    if (observed.windows.length) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.ok(observed.windows.length, 'native window');
  const before = await command('snapshot', { mode: 'window' });
  await fs.writeFile(path.join(output, 'before.jpg'), Buffer.from(before.data, 'base64'));
  if (!selected) {
    await command('control', { heldByUser: true });
    await command('input', { kind: 'click', windowId: before.windowId, x: 100, y: 90 });
    await new Promise(resolve => setTimeout(resolve, 300));
    const after = await command('snapshot', { mode: 'window', windowId: before.windowId });
    await fs.writeFile(path.join(output, 'after.jpg'), Buffer.from(after.data, 'base64'));
    assert.notEqual(before.data, after.data, 'posted click changes native pixels');
  }
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify({ state, observed, before: { ...before, data: undefined }, events }, null, 2));
  console.log(JSON.stringify({ ok: true, output, application: selected ?? 'fixture' }));
} finally { await service.dispose(); }

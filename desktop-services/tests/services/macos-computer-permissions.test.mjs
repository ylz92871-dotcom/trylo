import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMacosComputerPermissions } from '../../src/tooling/computer-control/macos/permissions.mjs';
import { macosComputerExecutable } from '../../src/tooling/computer-control/macos/runtime.mjs';

test('permissions use the bundled helper and query without requesting consent', async () => {
  const calls = [];
  const status = { accessibility: true, postEvents: false, screenRecording: false };
  const query = createMacosComputerPermissions({ target: 'darwin-arm64', hostEntrypoint: '/app/desktop-services/dist/host.bundle.mjs',
    enabledByEnvironment: false, run: async (...args) => { calls.push(args); return { stdout: JSON.stringify(status) }; } });
  assert.deepEqual(await query(), { ...status, enabledByEnvironment: false });
  assert.ok(calls[0][0].replaceAll('\\', '/').endsWith('/app/desktop-services/macos-mcp/bin/trylo-macos-mcp'));
  assert.deepEqual(calls[0][1], ['--permissions']);
  await query({ request: 'screen' });
  assert.deepEqual(calls[1][1], ['--permissions', 'screen']);
  assert.equal(calls[1][2].timeout, 15_000);
});

test('unsupported targets and unknown requests never launch a helper', async () => {
  const run = async () => { assert.fail('must not launch'); };
  await assert.rejects(createMacosComputerPermissions({ target: 'win32-x64', run })(), /Apple Silicon/);
  await assert.rejects(createMacosComputerPermissions({ target: 'darwin-arm64', run })({ request: 'all' }), /Unknown/);
});

test('unreadable or incomplete helper observations are not reported as permission success', async () => {
  const query = stdout => createMacosComputerPermissions({ target: 'darwin-arm64', run: async () => ({ stdout }) });
  await assert.rejects(query('not-json')());
  await assert.rejects(query('{"accessibility":true}')(), /Missing/);
  assert.ok(macosComputerExecutable().replaceAll('\\', '/').includes('/desktop/src-tauri/resources/desktop-services/macos-mcp/bin/'));
});

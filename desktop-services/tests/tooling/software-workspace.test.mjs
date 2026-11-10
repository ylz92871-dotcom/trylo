import test from 'node:test';
import assert from 'node:assert/strict';
import { createSoftwareWorkspace } from '../../src/tooling/software-workspace-service.mjs';

const scope = { projectRoot: process.cwd(), conversationId: 'workspace-contract' };
function harness({ dialog = false } = {}) {
  const commands = [], events = [];
  let complete;
  const service = createSoftwareWorkspace({ storageRoot: process.cwd(), platform: 'win32',
    resolveRuntime: async () => ({ executable: 'python', entry: 'controller.py' }),
    prepareDirectory: async () => 'runtime', emit: (topic, value) => events.push({ topic, value }),
    createProcess: () => ({
      async request(operation, params) {
        commands.push({ operation, params });
        if (operation === 'status') return { applications: [{ id: '1', name: 'CAD', running: true }], windows: dialog ? [{ id: 'dialog', dialog: true }] : [] };
        if (operation === 'discover') return { applications: [] };
        if (operation === 'rpc') return new Promise(resolve => { complete = resolve; });
        return { ok: true };
      }, async stop() { commands.push({ operation: 'stop' }); },
    }),
  });
  return { service, commands, events, complete: value => complete(value) };
}

test('profile preparation does not launch a worker; disabled foreground attachment is never attempted', async () => {
  const h = harness();
  await h.service.configure(scope);
  assert.equal(h.commands.length, 0);
  await h.service.command({ ...scope, operation: 'status' });
  assert.equal(h.commands[0].operation, 'status');
  await h.service.dispose();
});

test('a user can resolve an owned modal dialog while the API call drains, without gaining main-window input', async () => {
  const h = harness({ dialog: true });
  const connection = await h.service.configure({ ...scope, packageId: 'solidworks-mcp', server: { command: 'python', args: [], env: {} } });
  const call = fetch(`${connection.gate}/api`, { method: 'POST', body: JSON.stringify({ packageId: 'solidworks-mcp', clientId: 'dialog-client', message: { id: 1, method: 'tools/call', params: { name: 'solidworks_connect' } } }) });
  while (!h.commands.some(item => item.operation === 'rpc')) await new Promise(resolve => setImmediate(resolve));
  await h.service.command({ ...scope, operation: 'control', input: { heldByUser: true } });
  await h.service.command({ ...scope, operation: 'input', input: { windowId: 'dialog', kind: 'key', key: 'Enter' } });
  assert.equal(h.commands.find(item => item.operation === 'input').params.dialogOnly, true);
  await assert.rejects(h.service.command({ ...scope, operation: 'input', input: { windowId: 'main', kind: 'key', key: 'Enter' } }), /只能处理/);
  h.complete({ id: 1, result: {} }); await call;
  await h.service.dispose();
});

test('user takeover blocks new model writes and drains the active API call before user input', async () => {
  const h = harness();
  const connection = await h.service.configure({ ...scope, packageId: 'solidworks-mcp', server: { command: 'python', args: ['server.py'], env: {} } });
  const call = fetch(`${connection.gate}/api`, { method: 'POST', body: JSON.stringify({ packageId: 'solidworks-mcp', clientId: 'test-client', message: { id: 1, method: 'tools/call', params: { name: 'solidworks_connect' } } }) });
  while (!h.commands.some(item => item.operation === 'rpc')) await new Promise(resolve => setImmediate(resolve));
  const held = await h.service.command({ ...scope, operation: 'control', input: { heldByUser: true } });
  assert.equal(held.control, 'pending');
  await assert.rejects(h.service.command({ ...scope, operation: 'input', input: { windowId: '1', kind: 'key', key: 'Enter' } }), /正在完成/);
  const rejected = await fetch(`${connection.gate}/call`, { method: 'POST', body: JSON.stringify({ operation: 'open', input: { path: 'CAD.exe' } }) });
  assert.equal(rejected.status, 409);
  assert.equal(h.commands.filter(item => item.operation === 'launch').length, 0);
  h.complete({ id: 1, result: {} });
  await call;
  assert.equal((await h.service.command({ ...scope, operation: 'status' })).control, 'user');
  await h.service.dispose();
});

test('scope tokens, origin checks, validation and closed sessions cannot execute stray commands', async () => {
  const h = harness();
  const { gate } = await h.service.configure(scope);
  const badOrigin = await fetch(`${gate}/call`, { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' });
  assert.equal(badOrigin.status, 403);
  const badToken = await fetch(gate.replace(/[^/]+$/, 'wrong') + '/call', { method: 'POST', body: '{}' });
  assert.equal(badToken.status, 404);
  await assert.rejects(h.service.command({ ...scope, operation: 'input', input: { windowId: '1', kind: 'click', x: -1, y: 0 } }), /coordinates/);
  assert.equal(h.commands.length, 0);
  await h.service.dispose();
  await assert.rejects(h.service.command({ ...scope, operation: 'status' }), /closed/);
});

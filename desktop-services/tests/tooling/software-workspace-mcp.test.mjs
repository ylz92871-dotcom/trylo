import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runSoftwareWorkspaceMcp, softwareApiResult } from '../../src/tooling/software-workspace-mcp.mjs';
import { SOFTWARE_NAMES, softwareInput } from '../../src/tooling/software-workspace-contract.mjs';

test('MCP discovery is stable; a failed unknown call returns to the model and the next call still works', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const messages = [];
  let buffer = '';
  stdout.on('data', bytes => {
    buffer += String(bytes);
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
    }
  });
  await runSoftwareWorkspaceMcp({ gate: `http://127.0.0.1:1/${'a'.repeat(64)}`, stdin, stdout });
  for (const request of [{ id: 1, method: 'tools/call', params: { name: 'unknown' } }, { id: 2, method: 'tools/list' }]) stdin.write(JSON.stringify(request) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.find(message => message.id === 1).result.isError, true);
  assert.deepEqual(messages.find(message => message.id === 2).result.tools.map(tool => tool.name), SOFTWARE_NAMES);
  stdin.end();
});

test('pinned SW business failure is reported honestly without changing its content', () => {
  const response = { id: 9, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'busy' }) }], isError: false } };
  const corrected = softwareApiResult('solidworks-mcp', { method: 'tools/call' }, response);
  assert.equal(corrected.result.isError, true);
  assert.deepEqual(corrected.result.content, response.result.content);
  assert.equal(softwareApiResult('autocad-mcp', { method: 'tools/call' }, response), response);
});

test('executable arguments and drag coordinates validate before native dispatch', () => {
  assert.deepEqual(softwareInput('open', { path: 'bin/application.exe', args: ['drawing.step'] }).args, ['drawing.step']);
  assert.throws(() => softwareInput('open', { path: 'app.exe', args: ['\0'] }), /arguments/);
  assert.throws(() => softwareInput('input', { kind: 'click', windowId: '1', x: 0, y: 0, path: [[0, -1]] }), /drag/);
});

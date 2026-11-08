import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { runNativeBrowserMcp } from '../../src/tooling/native-browser-mcp.mjs';

async function fixture(t, { holdLeaseEnd = false, holdPreview = false, previewError } = {}) {
  let releaseLease;
  const leaseEnd = new Promise(resolve => { releaseLease = resolve; });
  let leaseEnded;
  const leaseEnding = new Promise(resolve => { leaseEnded = resolve; });
  let releasePreview, previewEntered;
  const preview = new Promise(resolve => { releasePreview = resolve; });
  const previewStarting = new Promise(resolve => { previewEntered = resolve; });
  const previewCalls = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const value = JSON.parse(body || '{}');
    const route = request.url.split('/').pop();
    if (route === 'end') {
      leaseEnded();
      if (holdLeaseEnd) await leaseEnd;
    }
    if (route === 'resolve') {
      previewCalls.push(value);
      previewEntered();
      if (holdPreview) await preview;
      if (previewError) {
        response.writeHead(403, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: previewError }));
        return;
      }
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(route === 'open' ? { clientId: 'client' }
      : route === 'start' ? { leaseId: 'lease' }
        : route === 'resolve' ? { url: `http://127.0.0.1/preview${new URL(value.url).search}${new URL(value.url).hash}` } : { ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const forwarded = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) { forwarded.push(JSON.parse(String(chunk))); child.emit('forwarded'); done(); } });
  child.kill = () => {};
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const firstOutput = once(stdout, 'data', { signal: AbortSignal.timeout(2000) });
  const relay = await runNativeBrowserMcp({ gate: `http://127.0.0.1:${server.address().port}/aabbcc`, entry: '/fixture/mcp.js', stdin, stdout, stderr, spawnProcess: () => child });
  t.after(async () => {
    releaseLease(); releasePreview(); await relay.stop();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    stdin.destroy(); stdout.destroy(); stderr.destroy();
  });
  return { child, stdin, forwarded, leaseEnding, releaseLease, firstOutput, previewStarting, releasePreview, previewCalls,
    messages: () => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

test('a final upstream result survives process exit while its call lease settles', async t => {
  const f = await fixture(t, { holdLeaseEnd: true });
  const forwarded = once(f.child, 'forwarded');
  f.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } }) + '\n');
  await forwarded;
  f.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 17, result: { content: [{ type: 'text', text: 'completed' }] } }) + '\n');
  await f.leaseEnding;
  f.child.emit('exit', 0, null);
  f.child.stdout.end(); f.child.emit('close', 0, null);
  await f.firstOutput;
  assert.deepEqual(f.messages(), [{ jsonrpc: '2.0', id: 17, result: { content: [{ type: 'text', text: 'completed' }] } }]);
});

test('an upstream crash returns a failure for every outstanding request identity', async t => {
  const f = await fixture(t);
  f.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'initializing', method: 'initialize', params: {} }) + '\n');
  f.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'tools/list', params: {} }) + '\n');
  f.child.emit('error', new Error('spawn EACCES'));
  f.child.emit('close', null, null);
  await f.firstOutput;
  const messages = f.messages();
  assert.deepEqual(messages.map(message => message.id), ['initializing', 22]);
  assert.ok(messages.every(message => message.error?.code === -32000 && /spawn EACCES/.test(message.error.message) && !message.result));
});

test('cancellation during local preview resolution never dispatches the tool', async t => {
  const f = await fixture(t, { holdPreview: true });
  f.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'file:///D:/fixture/index.html' } } }) + '\n');
  await f.previewStarting;
  f.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 31 } }) + '\n');
  f.releasePreview();
  await f.firstOutput;
  assert.equal(f.forwarded.some(message => message.method === 'tools/call'), false);
  assert.equal(f.messages()[0].id, 31);
  assert.ok(f.messages()[0].error);
});

const fileNavigations = [
  ['browser_navigate', {}],
  ['browser_tabs', { action: 'new' }],
  ['new_page', { background: true, timeout: 12000 }],
  ['navigate_page', { pageId: 7, type: 'url', timeout: 12000, ignoreCache: true }],
  ['navigate_page', { pageId: 7, timeout: 12000 }],
];

for (const [name, fields] of fileNavigations) {
  test(`${name} ${fields.type ?? 'default'} maps local HTML through the leased preview without changing other arguments`, async t => {
    const f = await fixture(t);
    const forwarded = once(f.child, 'forwarded');
    const url = 'file:///D:/%E8%B4%AA%E5%90%83%E8%9B%87/test/.trylo/out/dc-motor-teaching/index.html?mode=lesson#rotor';
    const params = { name, arguments: { ...fields, url } };
    f.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/call', params }) + '\n');
    await forwarded;
    f.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 41, result: { content: [] } }) + '\n');
    await f.firstOutput;
    assert.deepEqual(f.previewCalls, [{ clientId: 'client', leaseId: 'lease', url }]);
    assert.deepEqual(f.forwarded, [{ jsonrpc: '2.0', id: 41, method: 'tools/call',
      params: { ...params, arguments: { ...fields, url: 'http://127.0.0.1/preview?mode=lesson#rotor' } } }]);
  });
}

test('a refused local page never reaches either upstream navigation tool', async t => {
  const f = await fixture(t, { previewError: 'Local preview only serves static files inside this workspace' });
  f.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 51, method: 'tools/call',
    params: { name: 'new_page', arguments: { url: 'file:///D:/private/index.html' } } }) + '\n');
  await f.firstOutput;
  assert.equal(f.previewCalls.length, 1);
  assert.equal(f.forwarded.length, 0);
  assert.deepEqual(f.messages(), [{ jsonrpc: '2.0', id: 51, error: { code: -32000,
    message: 'Local preview only serves static files inside this workspace' } }]);
});

test('Chrome history navigation keeps its documented arguments and does not resolve a new URL', async t => {
  const f = await fixture(t);
  const forwarded = once(f.child, 'forwarded');
  const call = { jsonrpc: '2.0', id: 61, method: 'tools/call',
    params: { name: 'navigate_page', arguments: { pageId: 7, type: 'back', url: 'file:///D:/unused/index.html' } } };
  f.stdin.write(JSON.stringify(call) + '\n');
  await forwarded;
  assert.equal(f.previewCalls.length, 0);
  assert.deepEqual(f.forwarded, [call]);
  f.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 61, result: { content: [] } }) + '\n');
  await f.firstOutput;
});

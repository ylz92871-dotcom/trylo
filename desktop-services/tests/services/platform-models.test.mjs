import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRelayClient } from '../../src/remote/relay-client.mjs';
import { createModelGateway } from '../../src/remote/model-gateway.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-platform-models-'));
  const bearer = 'synthetic-native-account-session-for-testing-only', calls = [];
  let allowed = true, fail = false;
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (!['/relay/login'].includes(request.url)) assert.equal(request.headers.authorization, 'Bearer ' + bearer);
    let data;
    if (request.url === '/relay/login') data = { username: 'operator', accessToken: bearer, expiresAt: Date.now() + 2 * 86400000 };
    else if (request.url === '/relay/account') data = { username: 'operator' };
    else if (request.url === '/relay/logout') data = { ok: true };
    else if (request.url === '/relay/models') data = { enabled: true, models: allowed ? [{ id: 'chat', chat: true, pool: 'free', remaining: 998 }, { id: 'OCR', chat: false, pool: 'free' }, { id: 'voice', chat: false, pool: 'free' }] : [], reason: '无授权' };
    else if (request.url === '/relay/model-requests') {
      calls.push(body); assert.equal(body.pool, 'free'); assert.equal(body.model, 'chat'); assert.ok(body.requestKey.length >= 16); assert.equal(body.payload.model, undefined);
      if (fail) { response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: '上游连接中断', code: 'usage_uncertain' })); return; }
      if (body.payload.stream) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: {"choices":[{"delta":{"content":"汉字🙂"}}]}\n\n'); response.end('data: [DONE]\n\n'); return; }
      data = { requestId: 'ledger-fixture', result: { choices: [{ message: { role: 'assistant', content: '汉字🙂' } }] } };
    } else { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = createRelayClient({ appDataDir: directory, allowLocal: true });
  await client.login({ serverUrl: origin, username: 'operator', password: 'synthetic-password' });
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  return { client, calls, bearer, deny() { allowed = false; }, fail() { fail = true; } };
}
function send(connection, payload = {}, extra = {}) {
  return fetch(connection.apiHost + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + connection.apiKey, ...extra }, body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'hi' }], ...payload }) });
}
test('native model list hides specialists; a model-scoped loopback capability bridges JSON and SSE', async t => {
  const f = await fixture(t); const catalog = await f.client.models(); assert.deepEqual(catalog.models.map(x => x.id), ['chat']);
  const c = await f.client.modelConnection({ model: 'chat' }); assert.equal(c.providerId, 'openai-compatible'); assert.ok(c.apiHost.startsWith('http://127.0.0.1:')); assert.ok(!JSON.stringify(c).includes(f.bearer));
  const reply = await send(c); assert.equal(reply.status, 200); assert.equal((await reply.json()).choices[0].message.content, '汉字🙂');
  const stream = await send(c, { stream: true }); const wire = await stream.text(); assert.match(wire, /汉字🙂/); assert.match(wire, /\[DONE\]/); assert.equal(f.calls.length, 2);
  assert.equal((await send(c, { model: 'OCR' })).status, 403); assert.equal((await send(c, {}, { Origin: 'https://untrusted.invalid' })).status, 403); assert.equal(f.calls.length, 2);
  await assert.rejects(f.client.modelConnection({ model: 'voice' }), /未获授权/);
  await f.client.logout(); assert.equal((await send(c)).status, 401); assert.equal(f.calls.length, 2);
});
test('server-side grant changes and upstream failures never fall back or replay', async t => {
  const f = await fixture(t); const c = await f.client.modelConnection({ model: 'chat' });
  f.fail(); const failed = await send(c); assert.equal(failed.status, 409); assert.equal(f.calls.length, 1); assert.equal((await failed.json()).error.code, 'usage_uncertain');
  f.deny(); await assert.rejects(f.client.modelConnection({ model: 'chat' }), /未获授权/); assert.equal(f.calls.length, 1);
});
test('long workflows reuse a model capability instead of exhausting the lease limit at 128 turns', async t => {
 const gateway=createModelGateway({account:async()=>({owner:'operator'}),models:async()=>({models:[{id:'chat',chat:true,pool:'free'}]})});t.after(()=>gateway.close());
 const first=await gateway.connection({model:'chat'});for(let i=0;i<140;i++)assert.equal((await gateway.connection({model:'chat'})).apiKey,first.apiKey);
 gateway.invalidate();assert.notEqual((await gateway.connection({model:'chat'})).apiKey,first.apiKey);
});

test('context-sized model requests are bounded and reused leases retain fresh catalog capacity', async t => {
  let calls = 0, capacity = 1_000_000;
  const gateway = createModelGateway({
    account: async () => ({ owner: 'fixture', serverUrl: 'http://127.0.0.1:1', accessToken: 'synthetic-session' }),
    models: async () => ({ models: [{ id: 'chat', chat: true, pool: 'free', contextLength: capacity }] }),
    transport: async () => { calls++; return Response.json({ result: { choices: [] } }); },
  });
  t.after(() => gateway.close());
  const first = await gateway.connection({ model: 'chat' });
  assert.equal(first.modelContextWindow, 1_000_000);
  const accepted = await send(first, { messages: [{ role: 'user', content: 'x'.repeat(600_000) }] });
  assert.equal(accepted.status, 200); await accepted.text();
  capacity = 128_000;
  const reused = await gateway.connection({ model: 'chat' });
  assert.equal(reused.apiKey, first.apiKey);
  assert.equal(reused.modelContextWindow, 128_000);
  const rejected = await send(reused, { messages: [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }] });
  assert.equal(rejected.status, 413); await rejected.text();
  assert.equal(calls, 1);
});

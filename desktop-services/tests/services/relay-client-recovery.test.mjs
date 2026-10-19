import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createRelayClient } from '../../src/remote/relay-client.mjs';

async function until(predicate) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.fail('Relay recovery was not observed');
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-relay-recovery-'));
  const sockets = [], states = [];
  let pairingCount = 0, deferReady = false, ignoreFirstPings = false;
  const server = http.createServer((request, response) => {
    let value;
    if (request.url === '/relay/login') value = { username: 'fixture', accessToken: 'account-fixture-token-xxxxxxxxxxxxxxxx', expiresAt: Date.now() + 600000 };
    else if (request.url === '/relay/devices') value = { deviceId: 'fixture-device', deviceSecret: 'device-fixture-secret-xxxxxxxxxxxxxxxx' };
    else if (request.url === '/relay/devices/fixture-device/pairing') value = { ticket: `fixture-ticket-${++pairingCount}`, expiresAt: Date.now() + 120000 };
    else { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
  });
  const websocket = new WebSocketServer({ noServer: true, autoPong: false });
  server.on('upgrade', (request, socket, head) => websocket.handleUpgrade(request, socket, head, connection => {
    sockets.push(connection); const first = sockets.length === 1;
    connection.on('error', () => {});
    connection.on('ping', data => { if (!(first && ignoreFirstPings)) connection.pong(data); });
    if (!deferReady) connection.send(JSON.stringify({ type: 'relay.ready' }));
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createRelayClient({ appDataDir: directory, allowLocal: true, onStatus: state => states.push(state.online), seam: { heartbeatIntervalMs: 25, heartbeatTimeoutMs: 125 } });
  t.after(async () => {
    await client.disable(); for (const socket of sockets) socket.terminate();
    await new Promise(resolve => server.close(resolve)); websocket.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await client.login({ serverUrl, username: 'fixture', password: 'fixture-only-password' });
  const target = { serverUrl, baseUrl: 'http://127.0.0.1:49380', token: 'local-fixture-token', deviceId: 'desktop-identity', deviceName: 'Fixture', workspaceName: 'Fixture workspace' };
  return { client, sockets, states, target, enable: () => client.enable(target), defer() { deferReady = true; }, blackholeFirst() { ignoreFirstPings = true; } };
}

test('silent half-open relay channels are detected and automatically reconnected', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.blackholeFirst();
  assert.equal((await f.enable()).online, true);
  await until(async () => f.sockets.length >= 2 && (await f.client.status()).online);
  assert.ok(f.states.some((value, index) => index > f.states.indexOf(true) && !value));
  const qr = await f.client.pairing();
  assert.equal(qr.pairing.deviceId, 'desktop-identity');
});

test('concurrent QR retries share the pending reconnect handshake', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.enable(); f.defer();
  f.sockets[0].terminate(); await until(async () => !(await f.client.status()).online);
  const first = f.client.pairing(), second = f.client.pairing();
  await until(() => f.sockets.length >= 2);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].send(JSON.stringify({ type: 'relay.ready' }));
  const results = await Promise.all([first, second]);
  assert.equal(results.length, 2); assert.equal(f.sockets.length, 2);
});

test('disabling during a QR reconnect never returns a stale pairing', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.enable(); f.defer();
  f.sockets[0].terminate(); await until(async () => !(await f.client.status()).online);
  const pending = assert.rejects(f.client.pairing());
  await until(() => f.sockets.length >= 2);
  await f.client.disable(); await pending;
  assert.equal((await f.client.status()).online, false);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(f.sockets.length, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRelayServer, allowedRemoteRoute } from '../src/server.mjs';
import { createRemoteServices } from '../../desktop-services/src/remote/index.mjs';
import { allowedRelayRoute, relayUrl } from '../../desktop-services/src/remote/relay-client.mjs';

const inviteCode = 'test-invite-with-at-least-32-characters';
const password = 'test-only-password-123456';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-relay-test-'));
  let clock = Date.now();
  let relay = await createRelayServer({ dataDir: path.join(directory, 'relay'), inviteCode, now: () => clock });
  const address = await relay.listen(0);
  const url = `http://127.0.0.1:${address.port}`;
  const desktops = [], sockets = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); for (const desktop of desktops) await desktop.disable(); await relay.close(); await fs.rm(directory, { recursive: true, force: true }); });
  async function request(route, { token, deviceId, body, method = 'POST' } = {}) {
    const response = await fetch(url + route, { method, signal: AbortSignal.timeout(10000),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(deviceId ? { 'X-Trylo-Device': deviceId } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => ({})); return { status: response.status, data, response };
  }
  async function desktop(username, register = true) {
    const calls = [];
    const service = createRemoteServices({ appDataDir: path.join(directory, `desktop-${desktops.length}`), seam: { tunnel: false, allowLocalRelay: true },
      emit(topic, value) { if (topic === 'host.remoteRequest') { calls.push(value); queueMicrotask(() => service.respond({ requestId: value.requestId, ok: true, result: value.name === 'artifactContent' ? { content: 'unused' } : {} })); } } });
    desktops.push(service);
    await service.relayLogin({ serverUrl: url, username, password, register, inviteCode });
    const state = await service.enable({ connectionMode: 'server', relayUrl: url, port: 1024 + desktops.length, deviceName: username });
    assert.equal(state.running, true);
    const qr = await service.pairingInfo();
    assert.match(qr.qrDataUrl, /^data:image\/png;base64,/);
    assert.equal(qr.pairing.connectionMode, 'server');
    return { service, calls, pairing: qr.pairing };
  }
  async function pair(pairing) { const response = await request('/relay/pair', { body: { ticket: pairing.token } }); assert.equal(response.status, 201); return { token: response.data.accessToken, deviceId: response.data.relayDeviceId }; }
  async function stream(credentials) {
    const ticket = await request('/v1/socket-ticket', credentials); assert.equal(ticket.status, 201);
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/v1/events?ticket=' + ticket.data.ticket);
    sockets.push(socket); const messages = []; socket.on('message', data => messages.push(JSON.parse(data.toString())));
    await once(socket, 'open'); return { socket, messages, ticket: ticket.data.ticket };
  }
  return { relay, directory, request, desktop, pair, stream, url, advance(ms) { clock += ms; }, async restart() {
    await relay.close();
    relay = await createRelayServer({ dataDir: path.join(directory, 'relay'), inviteCode, now: () => clock });
    await relay.listen(address.port);
  } };
}
async function waitFor(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Expected event did not arrive');
}

test('QR refresh immediately reconnects the relay while preserving gateway and phone pairing', { timeout: 20000 }, async t => {
  const f = await fixture(t), desktop = await f.desktop('refresh-owner');
  const phone = await f.pair(desktop.pairing);
  const before = await f.request('/v1/snapshot', { ...phone, method: 'GET' });
  await f.restart();
  await waitFor(() => desktop.service.status().reasonCode === 'relay_reconnecting');
  const qr = await desktop.service.pairingInfo();
  assert.equal(qr.pairing.deviceId, before.data.device.id);
  assert.notEqual(qr.pairing.token, desktop.pairing.token);
  assert.equal((await f.request('/v1/snapshot', { ...phone, method: 'GET' })).status, 200);
  assert.equal(desktop.calls.filter(call => call.name === 'task').length, 0);
});

test('Desktop authority: pairing, snapshots, live events, task and approval all traverse the relay', { timeout: 30000 }, async t => {
  const f = await fixture(t), desktop = await f.desktop('owner-one');
  const phone = await f.pair(desktop.pairing);
  assert.equal((await f.request('/relay/pair', { body: { ticket: desktop.pairing.token } })).status, 401);
  const snapshot = await f.request('/v1/snapshot', { ...phone, method: 'GET' });
  assert.equal(snapshot.status, 200); assert.equal(snapshot.data.device.id, desktop.pairing.deviceId);
  const stream = await f.stream(phone);
  await waitFor(() => stream.messages.some(item => item.type === 'snapshot'));
  await desktop.service.publish({ type: 'agentState', state: 'running', detail: 'relay proof' });
  await waitFor(() => stream.messages.some(item => JSON.stringify(item).includes('relay proof')));
  assert.equal((await f.request('/v1/chat/messages', { ...phone, body: { text: 'relay command', surface: 'work' } })).status, 202);
  assert.equal(desktop.calls.find(item => item.name === 'task').payload.surface, 'work');
  assert.equal(desktop.calls.find(item => item.name === 'task').payload.text, 'relay command');
  assert.equal((await f.request('/v1/permissions/approval-one/decision', { ...phone, body: { decision: 'allow' } })).status, 200);
  assert.deepEqual(desktop.calls.find(item => item.name === 'permission').payload, { requestId: 'approval-one', decision: 'allow' });
  assert.equal((await f.request('/v1/sessions', { ...phone, body: { surface: 'work' } })).status, 202);
  assert.equal((await f.request('/v1/projects/project-one/select', phone)).status, 202);
  assert.equal((await f.request('/v1/tasks/current/cancel', phone)).status, 200);
  assert.equal((await f.request('/v1/admin/handoff', phone)).status, 404);
  const replay = new WebSocket(f.url.replace('http:', 'ws:') + '/v1/events?ticket=' + stream.ticket);
  replay.on('error', () => {}); await new Promise(resolve => replay.once('close', resolve));
  const closed = once(stream.socket, 'close'); await desktop.service.disable(); await closed;
  assert.equal((await f.request('/v1/snapshot', { ...phone, method: 'GET' })).status, 503);
  await desktop.service.enable({ connectionMode: 'server', relayUrl: f.url, port: 1025, deviceName: 'owner-one' });
  assert.equal((await f.request('/v1/snapshot', { ...phone, method: 'GET' })).status, 200);
  assert.equal(desktop.calls.filter(item => item.name === 'task').length, 1, 'No mutation replay');
  assert.equal((await desktop.service.relayStatus()).loggedIn, true);
  const raw = await fs.readFile(path.join(f.directory, 'relay', 'state.json'), 'utf8');
  assert.ok(!raw.includes(password)); assert.ok(!raw.includes(phone.token));
});

test('Accounts and paired phones cannot cross device boundaries; logout revokes phone access', { timeout: 30000 }, async t => {
  const f = await fixture(t), first = await f.desktop('owner-one'), second = await f.desktop('owner-two');
  const phone = await f.pair(first.pairing);
  assert.equal((await f.request('/v1/snapshot', { ...phone, deviceId: second.pairing.relayDeviceId, method: 'GET' })).status, 404);
  assert.equal((await f.request('/relay/devices', { ...phone, method: 'GET' })).status, 403);
  assert.equal(second.calls.length, 0);
  const stream = await f.stream(phone), closed = once(stream.socket, 'close');
  await first.service.relayLogout(); await closed;
  assert.equal((await f.request('/v1/snapshot', { ...phone, method: 'GET' })).status, 401);
  const otherPhone = await f.pair(second.pairing);
  assert.equal((await f.request('/v1/snapshot', { ...otherPhone, method: 'GET' })).status, 200);
});

test('Expired QR codes and login/invite failures are rejected', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/relay/register', { body: { username: 'owner-one', password, inviteCode: 'incorrect' } })).status, 403);
  const desktop = await f.desktop('owner-one'); f.advance(120001);
  assert.equal((await f.request('/relay/pair', { body: { ticket: desktop.pairing.token } })).status, 401);
  assert.equal((await f.request('/relay/login', { body: { username: 'owner-one', password: 'incorrect-password' } })).status, 401);
});

test('Desktop and server route contracts agree and reject non-remote operations', () => {
  for (const route of ['/v1/snapshot', '/v1/artifacts/content?path=result.txt', '/v1/fun', '/v1/admin/handoff', 'https://attacker/v1/snapshot', '/health', '/v1/snapshot\r\nx: y']) {
    for (const method of ['GET', 'POST', 'DELETE']) assert.equal(allowedRemoteRoute(method, route), allowedRelayRoute(method, route));
  }
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?token=secret']) assert.throws(() => relayUrl(url));
  assert.equal(relayUrl('https://relay.trylocode.me/'), 'https://relay.trylocode.me');
});

test('Malformed authenticated Desktop responses cannot crash the shared relay', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const account = await f.request('/relay/register', { body: { username: 'malformed-desktop', password, inviteCode } });
  const registered = await f.request('/relay/devices', { token: account.data.accessToken, body: { desktopIdentity: 'malformed-identity' } });
  const socket = new WebSocket(f.url.replace('http:', 'ws:') + '/relay/desktop', { headers: { Authorization: `Bearer ${registered.data.deviceSecret}`, 'X-Trylo-Device': registered.data.deviceId } });
  t.after(() => socket.terminate());
  const ready = once(socket, 'message'); await once(socket, 'open'); await ready;
  socket.on('message', bytes => {
    const frame = JSON.parse(bytes.toString());
    if (frame.type === 'relay.request') socket.send(JSON.stringify({ type: 'relay.response', id: frame.id, status: { toString: null }, body: '' }));
  });
  const response = await f.request('/v1/snapshot', { token: account.data.accessToken, deviceId: registered.data.deviceId, method: 'GET' });
  assert.equal(response.status, 502);
  assert.equal((await f.request('/health', { method: 'GET' })).status, 200);
});

test('Server restart preserves phone identity and Desktop reconnects without replaying actions', { timeout: 30000 }, async t => {
  const f = await fixture(t), desktop = await f.desktop('restart-owner'), phone = await f.pair(desktop.pairing);
  await f.request('/v1/chat/messages', { ...phone, body: { text: 'only once' } });
  const qr = await desktop.service.pairingInfo();
  await f.restart();
  await waitFor(() => desktop.service.status().running);
  const response = await f.request('/v1/snapshot', { ...phone, method: 'GET' });
  assert.equal(response.status, 200); assert.equal(response.data.device.id, desktop.pairing.deviceId);
  assert.equal(desktop.calls.filter(item => item.name === 'task').length, 1);
  assert.equal((await f.request('/relay/pair', { body: { ticket: qr.pairing.token } })).status, 401, 'Restart invalidates unconsumed ephemeral QR');
  await desktop.service.relayLogin({ serverUrl: f.url, username: 'restart-owner', password });
  assert.equal(desktop.service.status().running, true, 'Renewing the account preserves the device connection');
});

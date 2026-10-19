// Run against an installed relay with a temporary synthetic Desktop authority.
// No providers, user workspaces or existing Desktop pairing data are accessed.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import gateway from '../../desktop-services/vendor/legacy/remote-gateway/index.js';
import { createRemoteServices } from '../../desktop-services/src/remote/index.mjs';

async function main() {
  const serverUrl = process.env.RELAY_TEST_URL || 'http://127.0.0.1:8788';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-relay-probe-'));
  const calls = [], sockets = [];
  let loggedIn = false;
  const username = `relay-probe-${Date.now().toString(36)}`;
  const desktop = createRemoteServices({ appDataDir: directory,
    seam: { gateway, tunnel: false, allowLocalRelay: serverUrl === 'http://127.0.0.1:8788' },
    emit(topic, data) {
      if (topic !== 'host.remoteRequest') return;
      calls.push(data);
      queueMicrotask(() => desktop.respond({ requestId: data.requestId, ok: true, result: {} }));
    } });
  async function request(route, { token, deviceId, method = 'POST', body } = {}) {
    const response = await fetch(serverUrl + route, { method, signal: AbortSignal.timeout(15000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(deviceId ? { 'X-Trylo-Device': deviceId } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  }
  async function waitFor(predicate) {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Expected relay event did not arrive');
  }
  try {
    assert.ok(process.env.RELAY_INVITE_CODE, 'Registration invite required through environment');
    await desktop.relayLogin({ serverUrl, username, password: crypto.randomBytes(32).toString('base64url'), register: true, inviteCode: process.env.RELAY_INVITE_CODE });
    loggedIn = true;
    const enabled = await desktop.enable({ connectionMode: 'server', relayUrl: serverUrl, port: 49400, deviceName: 'isolated-relay-probe' });
    assert.equal(enabled.running, true, 'Desktop outbound relay connection');
    const qr = await desktop.pairingInfo();
    assert.ok(qr.qrDataUrl.startsWith('data:image/png;base64,'), 'QR encoding');
    const paired = await request('/relay/pair', { body: { ticket: qr.pairing.token } });
    assert.equal(paired.status, 201, 'Phone pairing');
    const phone = { token: paired.data.accessToken, deviceId: paired.data.relayDeviceId };
    assert.equal((await request('/relay/pair', { body: { ticket: qr.pairing.token } })).status, 401, 'One-time QR');
    const snapshot = await request('/v1/snapshot', { ...phone, method: 'GET' });
    assert.equal(snapshot.status, 200, 'Phone snapshot');
    assert.equal(snapshot.data.device.id, qr.pairing.deviceId, 'Bound Desktop identity');
    const ticket = await request('/v1/socket-ticket', phone);
    assert.equal(ticket.status, 201, 'Stream ticket');
    const url = new URL(serverUrl + '/v1/events'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', ticket.data.ticket);
    const socket = new WebSocket(url, { handshakeTimeout: 15000 }); sockets.push(socket);
    const frames = []; socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    socket.on('error', () => {}); await once(socket, 'open');
    await waitFor(() => frames.some(frame => frame.type === 'snapshot'));
    await desktop.publish({ type: 'agentState', state: 'running', detail: 'isolated-relay-probe-live-event' });
    await waitFor(() => frames.some(frame => JSON.stringify(frame).includes('isolated-relay-probe-live-event')));
    assert.equal((await request('/v1/chat/messages', { ...phone, body: { text: 'synthetic relay probe only', surface: 'work' } })).status, 202, 'Task routing');
    assert.equal(calls.find(call => call.name === 'task')?.payload.surface, 'work', 'Desktop Work authority');
    assert.equal((await request('/v1/permissions/synthetic-probe/decision', { ...phone, body: { decision: 'deny' } })).status, 200, 'Approval routing');
    assert.equal(calls.find(call => call.name === 'permission')?.payload.decision, 'deny', 'Desktop approval authority');
    const closed = new Promise(resolve => socket.once('close', resolve));
    await desktop.disable(); await closed;
    assert.equal((await request('/v1/snapshot', { ...phone, method: 'GET' })).status, 503, 'Offline status');
    await desktop.enable({ connectionMode: 'server', relayUrl: serverUrl, port: 49400, deviceName: 'isolated-relay-probe' });
    assert.equal((await request('/v1/snapshot', { ...phone, method: 'GET' })).status, 200, 'Reconnection');
    assert.equal(calls.filter(call => call.name === 'task').length, 1, 'No action replay');
    await desktop.relayLogout(); loggedIn = false;
    assert.equal((await request('/v1/snapshot', { ...phone, method: 'GET' })).status, 401, 'Credential revocation');
    console.log(JSON.stringify({ passed: true, serverUrl, probeAccount: username, qr: true, identity: true, eventStream: true,
      taskAndApprovalRouting: true, disconnectAndReconnect: true, noReplay: true, deviceAndPhoneCredentialsRevoked: true,
      boundary: 'Synthetic Desktop authority using the real gateway and production relay client; no native UI, model or phone-device acceptance' }));
  } finally {
    for (const socket of sockets) socket.terminate();
    if (loggedIn) await desktop.relayLogout().catch(() => {});
    await desktop.disable();
    if (directory.startsWith(path.join(os.tmpdir(), 'trylo-relay-probe-'))) await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(failure => { console.error(`Relay probe failed: ${failure.message}`); process.exitCode = 1; });

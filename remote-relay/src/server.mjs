import http from 'node:http';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';
import { createStore } from './store.mjs';
import { createAccounts } from './accounts.mjs';
import { serveConsole } from './web.mjs';
import { createModelService } from './model-service/service.mjs';
import { createCredentialVault } from './model-service/credentials.mjs';
import { createAmdExecutor } from './model-service/amd.mjs';

const scrypt = promisify(crypto.scrypt);
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const error = (status, message) => Object.assign(new Error(message), { status });
const MAX_BODY = 512 * 1024;
const MAX_FRAME = 20 * 1024 * 1024;
const routes = [
  ['GET', /^\/v1\/(snapshot|projects|chat\/history|artifacts)(\?.*)?$/],
  ['GET', /^\/v1\/artifacts\/content\?path=.+$/],
  ['POST', /^\/v1\/(chat\/messages|sessions|tasks\/current\/cancel)$/],
  ['POST', /^\/v1\/(projects|sessions)\/[^/?]+\/select$/],
  ['POST', /^\/v1\/permissions\/[^/?]+\/decision$/],
];
export const allowedRemoteRoute = (method, route) => typeof route === 'string' && route.length <= 4096 && !/[\r\n#]/.test(route) && routes.some(([verb, expression]) => verb === method && expression.test(route));

async function body(request, maximum = MAX_BODY) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) throw error(413, 'Request too large.');
    chunks.push(chunk);
  }
  if (!length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw error(400, 'Invalid JSON.'); }
}

export async function createRelayServer({ dataDir, inviteCode, now = Date.now, webOrigin = 'https://trylocode.me', secureCookies = true, allowLegacyRegistration = false, webDir, modelExecutor, modelRequestTimeoutMs, enableAmd = false, amdTransport } = {}) {
  if (!dataDir || (allowLegacyRegistration && (!inviteCode || inviteCode.length < 16))) throw new Error('RELAY_DATA_DIR and valid legacy invite configuration required.');
  const store = await createStore(dataDir);
  const devices = new Map(), pairings = new Map(), tickets = new Map(), requests = new Map(), channels = new Map(), rates = new Map();
  let authInFlight = 0;
  const send = (socket, frame) => {
    if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_FRAME) { socket?.terminate(); return false; }
    socket.send(JSON.stringify(frame)); return true;
  };
  const json = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
  };
  function limited(key, maximum = 15) {
    const old = rates.get(key);
    const entry = old && old.until > now() ? old : { count: 0, until: now() + 60000 };
    if (rates.size > 5000 && !old) throw error(429, 'Please retry later.');
    rates.set(key, entry);
    if (++entry.count > maximum) throw error(429, 'Please retry later.');
  }
  function authenticate(request) {
    const value = String(request.headers.authorization || '');
    if (!value.startsWith('Bearer ') || value.length > 512) throw error(401, 'Login required.');
    const session = store.read().sessions.find(item => same(item.hash, hash(value.slice(7))) && item.expiresAt > now());
    if (!session || !['account', 'phone'].includes(session.kind) || !store.read().users.some(user => user.id === session.userId && !user.disabled)) throw error(401, 'Session expired. Please sign in again.');
    return session;
  }
  function account(request) {
    const principal = authenticate(request);
    if (principal.kind !== 'account') throw error(403, 'Account login required.');
    return principal;
  }
  function ownedDevice(principal, id) {
    const device = store.read().devices.find(item => item.id === id && item.userId === principal.userId);
    if (!device || (principal.kind === 'phone' && principal.deviceId !== id)) throw error(404, 'Device not found.');
    return device;
  }
  function sessionFor(state, userId, kind, deviceId) {
    const value = secret();
    state.sessions = state.sessions.filter(item => item.expiresAt > now());
    if (state.sessions.length >= 10000) throw error(429, 'Session capacity reached.');
    const sessions = state.sessions.filter(item => item.userId === userId && item.kind === kind && item.deviceId === deviceId);
    if (sessions.length >= 50) throw error(429, 'Too many sessions. Sign out unused devices.');
    const expiresAt = now() + (kind === 'phone' ? 30 : 7) * 24 * 60 * 60 * 1000;
    state.sessions.push({ hash: hash(value), userId, kind, deviceId, expiresAt });
    return { accessToken: value, expiresAt };
  }
  function disconnect(deviceId, socket) {
    if (devices.get(deviceId) !== socket) return;
    devices.delete(deviceId);
    for (const [id, pending] of requests) if (pending.deviceId === deviceId) {
      clearTimeout(pending.timer); requests.delete(id);
      if (!pending.response.destroyed) json(pending.response, 503, { error: 'Desktop disconnected. The action will not be replayed.' });
    }
    for (const [id, channel] of channels) if (channel.deviceId === deviceId) { channels.delete(id); channel.socket.close(1012, 'Desktop disconnected'); }
  }
  async function removeDevice(principal, id) {
    const device = ownedDevice(principal, id);
    await store.change(state => {
      state.devices = state.devices.filter(item => item.id !== id);
      state.sessions = state.sessions.filter(item => item.deviceId !== id);
    });
    for (const map of [pairings, tickets]) for (const [key, entry] of map) if (entry.deviceId === id) map.delete(key);
    const socket = devices.get(id);
    if (socket) { disconnect(id, socket); socket.terminate(); }
    return device;
  }
  const vault = enableAmd ? await createCredentialVault({ store, directory: dataDir }) : null;
  const executor = modelExecutor || (enableAmd ? createAmdExecutor({ vault, ...(amdTransport ? { transport: amdTransport } : {}) }) : null);
  const modelService = await createModelService({ store, now, executor, vault, requestTimeoutMs: modelRequestTimeoutMs });
  const accounts = await createAccounts({ store, now, origin: webOrigin, secureCookies, limited, json, body, online: id => devices.has(id), removeDevice, modelService });
  function proxy(request, response, principal, url) {
    const deviceId = String(request.headers['x-trylo-device'] || '');
    ownedDevice(principal, deviceId);
    const route = url.pathname + url.search;
    if (!allowedRemoteRoute(request.method, route)) throw error(404, 'Unsupported remote operation.');
    const desktop = devices.get(deviceId);
    if (!desktop || desktop.readyState !== WebSocket.OPEN) throw error(503, 'Desktop is offline. Open Desktop and enable remote access.');
    if (requests.size >= 128 || [...requests.values()].filter(item => item.deviceId === deviceId).length >= 8) throw error(429, 'Desktop is busy.');
    return (async () => {
      const data = request.method === 'POST' ? await body(request) : undefined;
      if (devices.get(deviceId) !== desktop) throw error(503, 'Desktop connection changed.');
      if (requests.size >= 128 || [...requests.values()].filter(item => item.deviceId === deviceId).length >= 8) throw error(429, 'Desktop is busy.');
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        requests.delete(id); send(desktop, { type: 'relay.cancel', id });
        if (!response.destroyed) json(response, 504, { error: 'Desktop request timed out. Check its state before repeating the action.' });
      }, 45000);
      requests.set(id, { desktop, deviceId, response, timer });
      response.once('close', () => {
        const pending = requests.get(id);
        if (!pending) return;
        clearTimeout(timer); requests.delete(id); send(desktop, { type: 'relay.cancel', id });
      });
      send(desktop, { type: 'relay.request', id, method: request.method, path: route, body: data });
    })();
  }
  const server = http.createServer((request, response) => {
    const origin = String(request.headers.origin || '');
    if (['capacitor://localhost', 'http://localhost', 'https://localhost'].includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Trylo-Device');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    void (async () => {
      const url = new URL(request.url, 'http://relay');
      if (await serveConsole(request, response, url.pathname, webDir)) return;
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true, service: 'trylo-relay', version: 1 });
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/relay/auth/')) { await accounts.handle(request, response, url); return; }
      if (['/relay/model-quotas', '/relay/model-usage', '/relay/model-requests', '/relay/models'].includes(url.pathname)) {
        const principal = account(request); limited(`model:${principal.hash}`, 60);
        if (await modelService.handleUser(request, response, url, principal, { body, json }, '/relay')) return;
      }
      if (request.method === 'GET' && url.pathname === '/relay/account') {
        const principal = account(request), user = store.read().users.find(item => item.id === principal.userId);
        return json(response, 200, { username: user.username, expiresAt: principal.expiresAt });
      }
      if (request.method === 'POST' && url.pathname === '/relay/device-session') {
        const principal = account(request), data = await body(request);
        const device = ownedDevice(principal, data.deviceId);
        if (!same(device.secretHash, hash(String(data.deviceSecret || '')))) throw error(404, 'Device not found.');
        await store.change(state => {
          const session = state.sessions.find(item => item.hash === principal.hash && item.expiresAt > now());
          if (!session || !state.devices.some(item => item.id === device.id)) throw error(401, 'Session or device expired.');
          session.deviceId = device.id;
        });
        return json(response, 200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/relay/refresh') {
        const principal = account(request);
        const refreshed = await store.change(state => {
          if (!state.sessions.some(item => item.hash === principal.hash && item.expiresAt > now())) throw error(401, 'Session expired.');
          state.sessions = state.sessions.filter(item => item.hash !== principal.hash);
          return sessionFor(state, principal.userId, 'account', principal.deviceId);
        });
        return json(response, 200, { username: store.read().users.find(item => item.id === principal.userId).username, ...refreshed });
      }
      if (request.method === 'POST' && ['/relay/register', '/relay/login'].includes(url.pathname)) {
        limited(`auth:${request.socket.remoteAddress}`);
        if (authInFlight >= 2) throw error(429, 'Please retry shortly.');
        authInFlight++;
        try {
        const data = await body(request);
        if (!allowLegacyRegistration) {
          const result = await accounts.credentials(data, url.pathname === '/relay/register', 'account');
          return json(response, url.pathname === '/relay/register' ? 201 : 200, { username: result.user.username, accessToken: result.accessToken, expiresAt: result.expiresAt });
        }
        const username = String(data.username || '').trim().toLowerCase();
        const password = String(data.password || '');
        if (!/^[a-z0-9_.-]{3,64}$/.test(username) || password.length < 12 || password.length > 256) throw error(400, 'Use a 3–64 character username and a password of at least 12 characters.');
          if (url.pathname === '/relay/register') {
            if (!same(hash(String(data.inviteCode || '')), hash(inviteCode))) throw error(403, 'Invalid registration invite.');
            const salt = crypto.randomBytes(16).toString('hex');
            const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
            const result = await store.change(state => {
              if (state.users.length >= 1000) throw error(429, 'Registration is full.');
              if (state.users.some(user => user.username === username)) throw error(409, 'Username is unavailable.');
              const user = { id: crypto.randomUUID(), username, salt, passwordHash };
              state.users.push(user);
              return { username, ...sessionFor(state, user.id, 'account') };
            });
            return json(response, 201, result);
          }
          const user = store.read().users.find(item => item.username === username);
          const candidate = (await scrypt(password, user?.salt || 'unavailable-user', 64)).toString('hex');
          if (!user || !same(candidate, user.passwordHash)) throw error(401, 'Username or password is incorrect.');
          return json(response, 200, await store.change(state => ({ username, ...sessionFor(state, user.id, 'account') })));
        } finally { authInFlight--; }
      }
      if (request.method === 'POST' && url.pathname === '/relay/pair') {
        limited(`pair:${request.socket.remoteAddress}`, 30);
        const data = await body(request);
        const key = hash(String(data.ticket || ''));
        const pairing = pairings.get(key);
        if (!pairing || pairing.expiresAt <= now() || !store.read().sessions.some(item => item.hash === pairing.sessionHash && item.expiresAt > now())) throw error(401, 'Pairing code expired. Generate a new QR code on Desktop.');
        pairings.delete(key);
        const device = store.read().devices.find(item => item.id === pairing.deviceId && item.userId === pairing.userId);
        if (!device) throw error(404, 'Device is unavailable.');
        return json(response, 201, await store.change(state => ({ relayDeviceId: device.id, desktopIdentity: device.desktopIdentity, ...sessionFor(state, device.userId, 'phone', device.id) })));
      }
      if (request.method === 'POST' && url.pathname === '/relay/logout') {
        const principal = authenticate(request);
        await store.change(state => { state.sessions = state.sessions.filter(item => item.hash !== principal.hash); });
        for (const map of [pairings, tickets]) for (const [key, value] of map) if (value.sessionHash === principal.hash) map.delete(key);
        for (const channel of channels.values()) if (channel.sessionHash === principal.hash) channel.socket.close(1008, 'Signed out');
        return json(response, 200, { ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/relay/devices') {
        const principal = account(request);
        return json(response, 200, { devices: store.read().devices.filter(item => item.userId === principal.userId).map(({ id, name, desktopIdentity }) => ({ id, name, desktopIdentity, online: devices.has(id) })) });
      }
      if (request.method === 'POST' && url.pathname === '/relay/devices') {
        const principal = account(request), data = await body(request);
        const value = secret();
        const device = await store.change(state => {
          if (state.devices.length >= 10000 || state.devices.filter(item => item.userId === principal.userId).length >= state.limits.maxDevices) throw error(429, 'Device limit reached.');
          if (!/^[a-zA-Z0-9_-]{8,128}$/.test(String(data.desktopIdentity || ''))) throw error(400, 'Invalid Desktop identity.');
          const record = { id: crypto.randomUUID(), userId: principal.userId, name: String(data.name || 'Desktop').slice(0, 120), desktopIdentity: data.desktopIdentity, secretHash: hash(value) };
          state.devices.push(record);
          const ownerSession = state.sessions.find(item => item.hash === principal.hash);
          if (ownerSession) ownerSession.deviceId = record.id;
          return record;
        });
        return json(response, 201, { deviceId: device.id, deviceSecret: value });
      }
      const removal = url.pathname.match(/^\/relay\/devices\/([a-f0-9-]+)$/);
      if (request.method === 'DELETE' && removal) {
        await removeDevice(account(request), removal[1]);
        return json(response, 200, { ok: true });
      }
      const pair = url.pathname.match(/^\/relay\/devices\/([a-f0-9-]+)\/pairing$/);
      if (request.method === 'POST' && pair) {
        const principal = account(request), device = ownedDevice(principal, pair[1]);
        if (!devices.has(device.id)) throw error(503, 'Connect Desktop before pairing.');
        if (pairings.size >= 5000) throw error(429, 'Please retry later.');
        const value = secret(), expiresAt = now() + 120000;
        pairings.set(hash(value), { deviceId: device.id, userId: device.userId, expiresAt, sessionHash: principal.hash });
        return json(response, 201, { ticket: value, expiresAt });
      }
      if (request.method === 'POST' && url.pathname === '/v1/socket-ticket') {
        const principal = authenticate(request), deviceId = String(request.headers['x-trylo-device'] || '');
        ownedDevice(principal, deviceId);
        if (!devices.has(deviceId)) throw error(503, 'Desktop is offline.');
        if (tickets.size >= 5000) throw error(429, 'Please retry later.');
        const value = secret(); tickets.set(hash(value), { deviceId, expiresAt: now() + 30000, sessionHash: principal.hash });
        return json(response, 201, { ticket: value, expiresInMs: 30000 });
      }
      if (url.pathname.startsWith('/v1/')) return proxy(request, response, authenticate(request), url);
      throw error(404, 'Not found.');
    })().catch(failure => {
      if (!response.headersSent && !response.destroyed) json(response, failure.status || 500, { error: failure.status ? failure.message : 'Relay request failed.' });
      else response.destroy();
    });
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.maxConnections = 1024;
  const websockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    try {
      if (websockets.clients.size >= 512) throw error(429, 'Connection capacity reached');
      const url = new URL(request.url, 'http://relay');
      let deviceId, kind, sessionHash;
      if (url.pathname === '/relay/desktop') {
        deviceId = String(request.headers['x-trylo-device'] || '');
        const value = String(request.headers.authorization || '').replace(/^Bearer /, '');
        const device = store.read().devices.find(item => item.id === deviceId && same(item.secretHash, hash(value)));
        if (!device || value.length < 32) throw error(401, 'Unauthorized');
        kind = 'desktop';
      } else if (url.pathname === '/v1/events') {
        const key = hash(url.searchParams.get('ticket') || '');
        const ticket = tickets.get(key); tickets.delete(key);
        if (!ticket || ticket.expiresAt <= now() || !devices.has(ticket.deviceId) || !store.read().sessions.some(item => item.hash === ticket.sessionHash && item.expiresAt > now())) throw error(401, 'Unauthorized');
        deviceId = ticket.deviceId; kind = 'phone';
        sessionHash = ticket.sessionHash;
        if ([...channels.values()].filter(item => item.deviceId === deviceId).length >= 16) throw error(429, 'Too many connections');
      } else throw error(404, 'Not found');
      websockets.handleUpgrade(request, socket, head, connection => {
        connection.alive = true;
        connection.on('pong', () => { connection.alive = true; });
        connection.on('error', () => {});
        if (kind === 'desktop') {
          const previous = devices.get(deviceId);
          if (previous) { disconnect(deviceId, previous); previous.close(1012, 'Connection replaced'); }
          devices.set(deviceId, connection);
          send(connection, { type: 'relay.ready' });
          connection.on('close', () => disconnect(deviceId, connection));
          connection.on('message', bytes => {
            if (devices.get(deviceId) !== connection) return;
            let frame; try { frame = JSON.parse(bytes.toString()); } catch { return connection.close(1008, 'Invalid frame'); }
            if (frame?.type === 'relay.response') {
              const pending = requests.get(frame.id);
              if (!pending || pending.desktop !== connection) return;
              requests.delete(frame.id); clearTimeout(pending.timer);
              const status = frame.status;
              if (!Number.isInteger(status) || status < 200 || status > 599 || typeof frame.body !== 'string' || frame.body.length > 18 * 1024 * 1024) return json(pending.response, 502, { error: 'Invalid Desktop response.' });
              const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
              for (const name of ['content-type', 'content-disposition']) {
                if (typeof frame.headers?.[name] !== 'string') continue;
                try { http.validateHeaderValue(name, frame.headers[name]); headers[name] = frame.headers[name]; }
                catch { return json(pending.response, 502, { error: 'Invalid Desktop response headers.' }); }
              }
              pending.response.writeHead(status, headers); pending.response.end(Buffer.from(frame.body, 'base64'));
            } else if (['relay.event', 'relay.channelClosed'].includes(frame?.type)) {
              const channel = channels.get(frame.channelId);
              if (!channel || channel.deviceId !== deviceId || channel.desktop !== connection) return;
              if (frame.type === 'relay.channelClosed') channel.socket.close(1011, 'Desktop stream closed');
              else if (typeof frame.data === 'string' && Buffer.byteLength(frame.data) <= 2 * 1024 * 1024) {
                if (channel.socket.bufferedAmount > MAX_FRAME) channel.socket.terminate();
                else if (channel.socket.readyState === WebSocket.OPEN) channel.socket.send(frame.data);
              }
            }
          });
        } else {
          const desktop = devices.get(deviceId), channelId = crypto.randomUUID();
          channels.set(channelId, { deviceId, desktop, socket: connection, sessionHash });
          send(desktop, { type: 'relay.open', channelId });
          connection.on('message', () => connection.close(1008, 'Read-only event stream'));
          connection.on('close', () => { channels.delete(channelId); send(desktop, { type: 'relay.close', channelId }); });
        }
      });
    } catch (failure) { socket.end(`HTTP/1.1 ${failure.status || 401} Rejected\r\nConnection: close\r\n\r\n`); }
  });
  const heartbeat = setInterval(() => {
    for (const socket of websockets.clients) { if (!socket.alive) socket.terminate(); else { socket.alive = false; socket.ping(); } }
    for (const map of [pairings, tickets]) for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
    for (const [key, value] of rates) if (value.until <= now()) rates.delete(key);
    for (const channel of channels.values()) if (!store.read().sessions.some(item => item.hash === channel.sessionHash && item.expiresAt > now())) channel.socket.close(1008, 'Session expired');
  }, 20000);
  heartbeat.unref();
  return {
    server,
    listen(port = 8788, host = '127.0.0.1') { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address())); }); },
    async close() { clearInterval(heartbeat); for (const socket of websockets.clients) socket.terminate(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await modelService.close(); await store.close(); },
  };
}

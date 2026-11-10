import http from 'node:http';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';
import { createStore } from './store.mjs';
import { createAccounts, isAccountRoute, isAccountSecurityRoute } from './accounts.mjs';
import { serveConsole, isConsoleRoute } from './web.mjs';
import { createModelService } from './model-service/service.mjs';
import { createCredentialVault } from './model-service/credentials.mjs';
import { createAmdExecutor } from './model-service/amd.mjs';
import { createClientAddress, remoteContentPolicy, businessSessionAllowed, businessDeviceAllowed } from './security.mjs';
import { createTransportDefense, originFormTarget } from './transport-defense.mjs';
import { createSecurityDefense } from './security-defense.mjs';
import { parseBoundedJson } from './bounded-json.mjs';

const scrypt = promisify(crypto.scrypt);
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const error = (status, message) => Object.assign(new Error(message), { status });
const routes = [
  ['GET', /^\/v1\/(snapshot|projects|chat\/history|artifacts)(\?.*)?$/],
  ['GET', /^\/v1\/artifacts\/content\?path=.+$/],
  ['POST', /^\/v1\/(chat\/messages|sessions|tasks\/current\/cancel)$/],
  ['POST', /^\/v1\/(projects|sessions)\/[^/?]+\/select$/],
  ['POST', /^\/v1\/permissions\/[^/?]+\/decision$/],
];
export const allowedRemoteRoute = (method, route) => typeof route === 'string' && route.length <= 4096 && !/[\r\n#]/.test(route) && routes.some(([verb, expression]) => verb === method && expression.test(route));

export async function createRelayServer({ dataDir, inviteCode, now = Date.now, webOrigin = 'https://trylocode.me', secureCookies = true, allowLegacyRegistration = false, webDir, modelExecutor, modelRequestTimeoutMs, enableAmd = false, amdTransport, trustedProxyAddresses = [], transportLimits = {}, transportClock, onSecurityEvent = () => {}, securityLogger = () => {}, remoteArtifactsEnabled = false } = {}) {
  if (!dataDir || (allowLegacyRegistration && (!inviteCode || inviteCode.length < 16))) throw new Error('RELAY_DATA_DIR and valid legacy invite configuration required.');
  const clientAddress = createClientAddress(trustedProxyAddresses);
  const allowedOrigins = new Set([new URL(webOrigin).origin, 'capacitor://localhost', 'http://localhost', 'https://localhost']);
  const store = await createStore(dataDir);
  const security = createSecurityDefense({ directory: dataDir, now, emit: securityLogger });
  const transport = createTransportDefense({ clientAddress, trustedProxyAddresses, limits: transportLimits, clock: transportClock, event(kind, request, detail) {
    security.event({ type: kind, address: clientAddress(request), outcome: 'rejected' });
    onSecurityEvent(kind, request, detail);
  } });
  const body = transport.body;
  const emptyBody = async request => {
    if (!request.headers['transfer-encoding'] && Number(request.headers['content-length'] || 0) === 0) return;
    const empty = await body(request, 256);
    if (Object.keys(empty).length) throw Object.assign(error(400, 'This operation only accepts an empty object.'), { closeConnection: true });
  };
  const limited = security.limited;
  const devices = new Map(), pairings = new Map(), tickets = new Map(), requests = new Map(), channels = new Map();
  const responses = new WeakMap();
  let authInFlight = 0;
  const send = (socket, frame) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    const value = JSON.stringify(frame);
    if (!transport.canSend(socket, Buffer.byteLength(value), 'desktop')) { socket.terminate(); return false; }
    socket.send(value); return true;
  };
  const json = (response, status, value) => {
    if (status === 429 && !response.hasHeader('Retry-After')) response.setHeader('Retry-After', '60');
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
  };
  function authenticate(request) {
    const value = String(request.headers.authorization || '');
    if (!value.startsWith('Bearer ') || value.length > 512) throw error(401, 'Login required.');
    const state = store.read(), session = state.sessions.find(item => same(item.hash, hash(value.slice(7))) && item.expiresAt > now() && (item.absoluteExpiresAt ?? item.expiresAt) > now());
    const user = session && state.users.find(user => user.id === session.userId);
    if (!session || !['account', 'phone'].includes(session.kind) || !businessSessionAllowed(user, session)) throw error(401, 'Session expired. Please sign in again.');
    if (responses.has(request)) transport.admitOwner(request, responses.get(request), session.userId);
    return session;
  }
  function activeSession(sessionHash) {
    const state = store.read();
    const session = state.sessions.find(item => item.hash === sessionHash && item.expiresAt > now() && (item.absoluteExpiresAt ?? item.expiresAt) > now());
    return session && businessSessionAllowed(state.users.find(user => user.id === session.userId), session) && (!session.deviceId || state.devices.some(device => device.id === session.deviceId && device.userId === session.userId));
  }
  function activeDevice(id) {
    const state = store.read(), device = state.devices.find(item => item.id === id);
    return device && businessDeviceAllowed(state.users.find(user => user.id === device.userId), device);
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
  function sessionFor(state, userId, kind, deviceId, inherited) {
    const value = secret();
    state.sessions = state.sessions.filter(item => item.expiresAt > now());
    if (state.sessions.length >= 10000) throw error(429, 'Session capacity reached.');
    const sessions = state.sessions.filter(item => item.userId === userId && item.kind === kind && item.deviceId === deviceId);
    if (sessions.length >= 50) throw error(429, 'Too many sessions. Sign out unused devices.');
    const authenticatedAt = inherited?.authenticatedAt ?? (inherited ? now() - 30 * 86400000 : now());
    const absoluteExpiresAt = inherited?.absoluteExpiresAt ?? inherited?.expiresAt ?? authenticatedAt + 30 * 86400000;
    const expiresAt = Math.min(absoluteExpiresAt, now() + (kind === 'phone' ? 30 : 7) * 86400000);
    if (expiresAt <= now()) throw error(401, 'Sign in again to renew authentication.');
    state.sessions.push({ hash: hash(value), userId, kind, deviceId, expiresAt, authenticatedAt, absoluteExpiresAt, lastSeenAt: now(), restricted: Boolean(inherited?.restricted), mfaVerified: inherited?.mfaVerified === true });
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
      if (!activeSession(principal.hash)) throw error(401, 'Session expired.');
      state.devices = state.devices.filter(item => item.id !== id);
      state.sessions = state.sessions.filter(item => item.deviceId !== id);
    });
    for (const map of [pairings, tickets]) for (const [key, entry] of map) if (entry.deviceId === id) map.delete(key);
    const socket = devices.get(id);
    if (socket) { disconnect(id, socket); socket.terminate(); }
    return device;
  }
  function revokeUser(userId, deviceIds) {
    modelService.revokeUser(userId);
    const removed = new Set(deviceIds);
    for (const map of [pairings, tickets]) for (const [key, value] of map) if (value.userId === userId || removed.has(value.deviceId)) map.delete(key);
    for (const id of removed) {
      const socket = devices.get(id);
      if (socket) { disconnect(id, socket); socket.terminate(); }
    }
  }
  const vault = enableAmd ? await createCredentialVault({ store, directory: dataDir }) : null;
  const executor = modelExecutor || (enableAmd ? createAmdExecutor({ vault, ...(amdTransport ? { transport: amdTransport } : {}) }) : null);
  const modelService = await createModelService({ store, now, executor, vault, requestTimeoutMs: modelRequestTimeoutMs });
  const accounts = await createAccounts({ store, now, origin: webOrigin, secureCookies, limited, json, body, clientAddress, online: id => devices.has(id), removeDevice, revokeUser, modelService, mfaDirectory: dataDir, securityEvent: security.event, securityStatus: () => ({ ...security.snapshot(), policy: { remoteArtifactsEnabled, administratorMfaRequired: true } }), admitOwner: transport.admitOwner, admitSecurity: transport.admitSecurity });
  function proxy(request, response, principal, url) {
    const deviceId = String(request.headers['x-trylo-device'] || '');
    ownedDevice(principal, deviceId);
    if (!remoteArtifactsEnabled && ['/v1/artifacts', '/v1/artifacts/content'].includes(url.pathname)) throw error(403, '远程文件功能暂未开放，请等待安全更新。');
    const route = url.pathname + url.search;
    if (!allowedRemoteRoute(request.method, route)) throw error(404, 'Unsupported remote operation.');
    const desktop = devices.get(deviceId);
    if (!desktop || desktop.readyState !== WebSocket.OPEN) throw error(503, 'Desktop is offline. Open Desktop and enable remote access.');
    if (requests.size >= 128 || [...requests.values()].filter(item => item.deviceId === deviceId).length >= 8) throw error(429, 'Desktop is busy.');
    return (async () => {
      const data = request.method === 'POST' ? await body(request) : undefined;
      if (!activeSession(principal.hash)) throw error(401, 'Session expired.');
      if (devices.get(deviceId) !== desktop) throw error(503, 'Desktop connection changed.');
      if (requests.size >= 128 || [...requests.values()].filter(item => item.deviceId === deviceId).length >= 8) throw error(429, 'Desktop is busy.');
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        requests.delete(id); send(desktop, { type: 'relay.cancel', id });
        if (!response.destroyed) json(response, 504, { error: 'Desktop request timed out. Check its state before repeating the action.' });
      }, 45000);
      requests.set(id, { desktop, deviceId, request, response, timer, sessionHash: principal.hash });
      response.once('close', () => {
        const pending = requests.get(id);
        if (!pending) return;
        clearTimeout(timer); requests.delete(id); send(desktop, { type: 'relay.cancel', id });
      });
      send(desktop, { type: 'relay.request', id, method: request.method, path: route, body: data });
    })();
  }
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: transport.limits.headerTimeoutMs, requestTimeout: transport.limits.largeBodyTimeoutMs + 1000, connectionsCheckingInterval: transport.limits.parserCheckIntervalMs }, (request, response) => {
    responses.set(request, response);
    request.on('error', () => {});
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', remoteContentPolicy);
    const origin = String(request.headers.origin || '');
    if (['capacitor://localhost', 'http://localhost', 'https://localhost'].includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Trylo-Device');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    void (async () => {
      const url = originFormTarget(request.url);
      const hasBody = Boolean(request.headers['transfer-encoding']) || Number(request.headers['content-length'] || 0) > 0;
      const securityRoute = isAccountSecurityRoute(request.method, url.pathname);
      transport.admitHttp(request, response, request.method === 'GET' && url.pathname === '/health', securityRoute);
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) && hasBody) throw Object.assign(error(400, 'This operation does not accept a body.'), { closeConnection: true });
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      const native = request.method === 'GET' && ['/relay/account', '/relay/devices', '/relay/model-quotas', '/relay/model-usage', '/relay/models', '/health'].includes(url.pathname) || request.method === 'POST' && (['/relay/login', '/relay/register', '/relay/refresh', '/relay/device-session', '/relay/logout', '/relay/pair', '/relay/devices', '/relay/model-requests', '/v1/socket-ticket'].includes(url.pathname) || /^\/relay\/devices\/[a-zA-Z0-9-]+\/pairing$/.test(url.pathname)) || request.method === 'DELETE' && /^\/relay\/devices\/[a-zA-Z0-9-]+$/.test(url.pathname);
      if (!isConsoleRoute(request.method, url.pathname) && !isAccountRoute(request.method, url.pathname) && !native && !allowedRemoteRoute(request.method, url.pathname + url.search)) throw Object.assign(error(404, 'Not found.'), { closeConnection: true });
      limited(`${securityRoute ? 'security-http' : 'http'}:${clientAddress(request)}`, securityRoute ? 120 : 240);
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
        await emptyBody(request);
        const refreshed = await store.change(state => {
          if (!activeSession(principal.hash)) throw error(401, 'Session expired.');
          state.sessions = state.sessions.filter(item => item.hash !== principal.hash);
          return sessionFor(state, principal.userId, 'account', principal.deviceId, principal);
        });
        return json(response, 200, { username: store.read().users.find(item => item.id === principal.userId).username, ...refreshed });
      }
      if (request.method === 'POST' && ['/relay/register', '/relay/login'].includes(url.pathname)) {
        limited(`auth:${clientAddress(request)}`);
        const data = await body(request);
        if (authInFlight >= 2) throw error(429, 'Please retry shortly.');
        authInFlight++;
        try {
        if (!allowLegacyRegistration || url.pathname === '/relay/login') {
          const result = await accounts.credentials(data, url.pathname === '/relay/register', 'account', { address: clientAddress(request) });
          return json(response, url.pathname === '/relay/register' ? 201 : 200, { username: result.user.username, accessToken: result.accessToken, expiresAt: result.expiresAt, mfa: result.mfa });
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
        } finally { authInFlight--; }
      }
      if (request.method === 'POST' && url.pathname === '/relay/pair') {
        limited(`pair:${clientAddress(request)}`, 30);
        const data = await body(request);
        const key = hash(String(data.ticket || ''));
        const pairing = pairings.get(key);
        if (!pairing || pairing.expiresAt <= now() || !activeSession(pairing.sessionHash)) throw error(401, 'Pairing code expired. Generate a new QR code on Desktop.');
        pairings.delete(key);
        const device = store.read().devices.find(item => item.id === pairing.deviceId && item.userId === pairing.userId);
        if (!device) throw error(404, 'Device is unavailable.');
        return json(response, 201, await store.change(state => {
          if (!activeSession(pairing.sessionHash) || !activeDevice(device.id)) throw error(401, 'Pairing code expired.');
          const ownerSession = state.sessions.find(item => item.hash === pairing.sessionHash);
          return { relayDeviceId: device.id, desktopIdentity: device.desktopIdentity, ...sessionFor(state, device.userId, 'phone', device.id, ownerSession) };
        }));
      }
      if (request.method === 'POST' && url.pathname === '/relay/logout') {
        const principal = authenticate(request);
        await emptyBody(request);
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
          if (!activeSession(principal.hash)) throw error(401, 'Session expired.');
          if (state.devices.length >= 10000 || state.devices.filter(item => item.userId === principal.userId).length >= state.limits.maxDevices) throw error(429, 'Device limit reached.');
          if (!/^[a-zA-Z0-9_-]{8,128}$/.test(String(data.desktopIdentity || ''))) throw error(400, 'Invalid Desktop identity.');
          const record = { id: crypto.randomUUID(), userId: principal.userId, name: String(data.name || 'Desktop').slice(0, 120), desktopIdentity: data.desktopIdentity, secretHash: hash(value), mfaVerified: principal.mfaVerified === true };
          state.devices.push(record);
          const ownerSession = state.sessions.find(item => item.hash === principal.hash);
          if (ownerSession) ownerSession.deviceId = record.id;
          return record;
        });
        return json(response, 201, { deviceId: device.id, deviceSecret: value });
      }
      const removal = url.pathname.match(/^\/relay\/devices\/([a-f0-9-]+)$/);
      if (request.method === 'DELETE' && removal) {
        const principal = account(request); await emptyBody(request);
        await removeDevice(principal, removal[1]);
        return json(response, 200, { ok: true });
      }
      const pair = url.pathname.match(/^\/relay\/devices\/([a-f0-9-]+)\/pairing$/);
      if (request.method === 'POST' && pair) {
        const principal = account(request), device = ownedDevice(principal, pair[1]);
        await emptyBody(request);
        if (!activeSession(principal.hash)) throw error(401, 'Session expired.');
        if (!devices.has(device.id)) throw error(503, 'Connect Desktop before pairing.');
        if (pairings.size >= 5000) throw error(429, 'Please retry later.');
        const value = secret(), expiresAt = now() + 120000;
        pairings.set(hash(value), { deviceId: device.id, userId: device.userId, expiresAt, sessionHash: principal.hash });
        return json(response, 201, { ticket: value, expiresAt });
      }
      if (request.method === 'POST' && url.pathname === '/v1/socket-ticket') {
        const principal = authenticate(request), deviceId = String(request.headers['x-trylo-device'] || '');
        await emptyBody(request);
        if (!activeSession(principal.hash)) throw error(401, 'Session expired.');
        ownedDevice(principal, deviceId);
        if (!devices.has(deviceId)) throw error(503, 'Desktop is offline.');
        if (tickets.size >= 5000) throw error(429, 'Please retry later.');
        const value = secret(); tickets.set(hash(value), { deviceId, expiresAt: now() + 30000, sessionHash: principal.hash });
        return json(response, 201, { ticket: value, expiresInMs: 30000 });
      }
      if (url.pathname.startsWith('/v1/')) return proxy(request, response, authenticate(request), url);
      throw error(404, 'Not found.');
    })().catch(failure => {
      if (!response.headersSent && !response.destroyed) {
        if (failure.retryAfter) response.setHeader('Retry-After', String(failure.retryAfter));
        if (failure.closeConnection || !request.complete) response.setHeader('Connection', 'close');
        json(response, failure.status || 500, { error: failure.status ? failure.message : 'Relay request failed.', ...(failure.code ? { code: failure.code } : {}) });
      }
      else response.destroy();
    });
  });
  server.maxConnections = transport.limits.connectionsGlobal;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(transport.limits.socketIdleMs, socket => socket.destroy());
  server.on('connection', transport.connection);
  server.on('clientError', (failure, socket) => {
    security.event({ type: 'http.parser_rejected', address: clientAddress({ socket, headers: {} }), outcome: failure.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 'timeout' : 'malformed' });
    const status = failure.code === 'HPE_HEADER_OVERFLOW' ? 431 : failure.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400;
    if (socket.writable) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy()); else socket.destroy();
  });
  const websockets = new WebSocketServer({ noServer: true, maxPayload: transport.limits.wsDesktopPayload, perMessageDeflate: false });
  const phoneWebsockets = new WebSocketServer({ noServer: true, maxPayload: transport.limits.wsPhonePayload, perMessageDeflate: false });
  const allWebSockets = () => [...websockets.clients, ...phoneWebsockets.clients];
  server.on('upgrade', (request, socket, head) => {
    let release;
    try {
      const url = originFormTarget(request.url);
      if (request.method !== 'GET' || request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) > 0) throw error(400, 'Invalid WebSocket handshake');
      if (!['/relay/desktop', '/v1/events'].includes(url.pathname)) throw error(404, 'Not found');
      if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) throw error(403, 'Untrusted origin');
      limited(`socket:${clientAddress(request)}`, 60);
      let deviceId, kind, sessionHash, owner;
      if (url.pathname === '/relay/desktop') {
        deviceId = String(request.headers['x-trylo-device'] || '');
        const value = String(request.headers.authorization || '').replace(/^Bearer /, '');
        const device = store.read().devices.find(item => item.id === deviceId && same(item.secretHash, hash(value)));
        if (!device || value.length < 32 || !activeDevice(device.id)) throw error(401, 'Unauthorized');
        kind = 'desktop'; owner = device.userId;
      } else if (url.pathname === '/v1/events') {
        const key = hash(url.searchParams.get('ticket') || '');
        const ticket = tickets.get(key); tickets.delete(key);
        if (!ticket || ticket.expiresAt <= now() || !devices.has(ticket.deviceId) || !activeSession(ticket.sessionHash)) throw error(401, 'Unauthorized');
        deviceId = ticket.deviceId; kind = 'phone';
        sessionHash = ticket.sessionHash; owner = store.read().devices.find(item => item.id === deviceId)?.userId;
        if ([...channels.values()].filter(item => item.deviceId === deviceId).length >= 16) throw error(429, 'Too many connections');
      } else throw error(404, 'Not found');
      release = transport.admitWebSocket(request, kind, owner, deviceId);
      socket.once('close', release);
      const handler = kind === 'desktop' ? websockets : phoneWebsockets;
      handler.handleUpgrade(request, socket, head, connection => {
        transport.monitorWebSocket(connection, request, kind, owner, head);
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
            if (bytes.length > 64 * 1024) {
              // The shipped Desktop writes these routing fields first. Large
              // unsolicited frames must not force a full JSON/string copy or
              // identity-ledger read just to discover that no request exists.
              const envelope = bytes.subarray(0, 512).toString().match(/^\s*\{\s*"type"\s*:\s*"(relay\.response|relay\.event)"\s*,\s*"(id|channelId)"\s*:\s*"([a-f0-9-]{36})"\s*,/);
              const pending = envelope?.[1] === 'relay.response' && envelope[2] === 'id' ? requests.get(envelope[3]) : envelope?.[1] === 'relay.event' && envelope[2] === 'channelId' ? channels.get(envelope[3]) : null;
              if (!envelope) {
                security.event({ type: 'ws.envelope_rejected', address: clientAddress(request), outcome: 'unsolicited' });
                return connection.terminate();
              }
              if (!pending || pending.desktop !== connection) return;
            }
            let frame; try { frame = parseBoundedJson(bytes); } catch { return connection.close(1008, 'Invalid frame'); }
            if (!['relay.response', 'relay.event', 'relay.channelClosed'].includes(frame?.type)) return connection.close(1008, 'Unsupported frame');
            if (frame?.type === 'relay.response') {
              const pending = requests.get(frame.id);
              if (!pending || pending.desktop !== connection) return;
              if (!activeDevice(deviceId)) return connection.close(1008, 'Device revoked');
              requests.delete(frame.id); clearTimeout(pending.timer);
              if (!activeSession(pending.sessionHash)) return json(pending.response, 401, { error: 'Session expired.' });
              const status = frame.status;
              if (!Number.isInteger(status) || status < 200 || status > 599 || typeof frame.body !== 'string' || frame.body.length > 18 * 1024 * 1024) return json(pending.response, 502, { error: 'Invalid Desktop response.' });
              const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': remoteContentPolicy, 'Referrer-Policy': 'no-referrer' };
              for (const name of ['content-type', 'content-disposition']) {
                if (typeof frame.headers?.[name] !== 'string') continue;
                try { if (Buffer.byteLength(frame.headers[name]) > 8192) throw error(502, 'Desktop header too large.'); http.validateHeaderValue(name, frame.headers[name]); headers[name] = frame.headers[name]; }
                catch { return json(pending.response, 502, { error: 'Invalid Desktop response headers.' }); }
              }
              try { transport.reserveOutput(pending.request, pending.response, Math.ceil(frame.body.length * 3 / 4)); }
              catch { return json(pending.response, 429, { error: 'Output capacity reached.' }); }
              pending.response.writeHead(status, headers); pending.response.end(Buffer.from(frame.body, 'base64'));
            } else if (['relay.event', 'relay.channelClosed'].includes(frame?.type)) {
              const channel = channels.get(frame.channelId);
              if (!channel || channel.deviceId !== deviceId || channel.desktop !== connection) return;
              if (!activeDevice(deviceId)) return connection.close(1008, 'Device revoked');
              if (!activeSession(channel.sessionHash)) return channel.socket.close(1008, 'Session expired');
              if (frame.type === 'relay.channelClosed') channel.socket.close(1011, 'Desktop stream closed');
              else if (typeof frame.data === 'string' && Buffer.byteLength(frame.data) <= 2 * 1024 * 1024) {
                if (!transport.canSend(channel.socket, Buffer.byteLength(frame.data), 'phone')) channel.socket.terminate();
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
    } catch (failure) { release?.(); socket.end(`HTTP/1.1 ${failure.status || 401} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy()); }
  });
  const heartbeat = setInterval(() => {
    for (const socket of allWebSockets()) { if (!socket.alive) socket.terminate(); else { socket.alive = false; socket.ping(); } }
    for (const map of [pairings, tickets]) for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
    for (const [id, socket] of devices) if (!activeDevice(id)) { disconnect(id, socket); socket.terminate(); }
    for (const channel of channels.values()) if (!activeSession(channel.sessionHash)) channel.socket.close(1008, 'Session expired');
  }, 20000);
  heartbeat.unref();
  return {
    server,
    security,
    transport,
    listen(port = 8788, host = '127.0.0.1') { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address())); }); },
    async close() { clearInterval(heartbeat); for (const socket of allWebSockets()) socket.terminate(); transport.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await modelService.close(); security.close(); await store.close(); },
  };
}

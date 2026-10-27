import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import qrcode from 'qrcode';
import { execFile } from 'node:child_process';
import { createModelGateway } from './model-gateway.mjs';

export function relayUrl(value, allowLocal = false) {
  const url = new URL(String(value || ''));
  const local = allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('服务器地址必须是 HTTPS 根地址。');
  return url.origin;
}
const routes = [
  ['GET', /^\/v1\/(snapshot|projects|chat\/history|artifacts)(\?.*)?$/],
  ['GET', /^\/v1\/artifacts\/content\?path=.+$/],
  ['POST', /^\/v1\/(chat\/messages|sessions|tasks\/current\/cancel)$/],
  ['POST', /^\/v1\/(projects|sessions)\/[^/?]+\/select$/],
  ['POST', /^\/v1\/permissions\/[^/?]+\/decision$/],
];
export const allowedRelayRoute = (method, route) => typeof route === 'string' && route.length <= 4096 && !/[\r\n#]/.test(route) && routes.some(([verb, expression]) => method === verb && expression.test(route));

export function createRelayClient({ appDataDir = process.env.TRYLO_APP_DATA_DIR, onStatus = () => {}, allowLocal = false, seam = {} } = {}) {
  const file = appDataDir ? path.join(appDataDir, 'Trylo', 'remote', 'relay-session.json') : '';
  let session, loaded = false, socket, target, timer, generation = 0, online = false, wanted = false, delay = 1000;
  let browserGeneration = 0;
  async function openBrowser(url) {
    if (typeof seam.openBrowser === 'function') return seam.openBrowser(url);
    if (allowLocal) return;
    const executable = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    await new Promise((resolve, reject) => execFile(executable, args, { windowsHide: true, timeout: 10000 }, error => error ? reject(new Error('无法打开系统浏览器，请重试或复制登录链接。')) : resolve()));
  }
  let connecting;
  let browserLogin;
  let accountMonitor;
  async function modelAccount() {
    return serialize(async () => {
      await load(); await verifySession();
      if (!status().loggedIn) throw new Error('请先登录 Trylo 账号，再使用免费模型。');
      return { serverUrl: session.serverUrl, accessToken: session.accessToken, owner: session.serverUrl + ':' + session.username };
    });
  }
  async function modelList(current) {
    current ||= await modelAccount();
    const data = await api(current.serverUrl, '/relay/models', { method: 'GET', token: current.accessToken });
    if (current.owner !== session?.serverUrl + ':' + session?.username) throw new Error('账号已变化，请重新同步模型。');
    const models = Array.isArray(data.models) ? data.models.filter(item => item.chat === true && item.pool === 'free') : [];
    return { ...data, models, owner: current.owner };
  }
  const modelGateway = createModelGateway({ account: modelAccount, models: modelList });
  function monitorAccount() {
    if (accountMonitor || !session?.accessToken || session.expiresAt <= Date.now()) return;
    accountMonitor = setInterval(() => { void serialize(() => verifySession()).catch(() => {}); }, seam.accountCheckIntervalMs ?? 300000);
    accountMonitor.unref?.();
  }
  function stopAccountMonitor() { clearInterval(accountMonitor); accountMonitor = undefined; }
  const heartbeatIntervalMs = seam.heartbeatIntervalMs ?? 15000;
  const heartbeatTimeoutMs = seam.heartbeatTimeoutMs ?? 45000;
  const requests = new Map(), channels = new Map();
  let mutations = Promise.resolve();
  function serialize(operation) { const next = mutations.then(operation); mutations = next.catch(() => {}); return next; }
  async function load() {
    if (loaded) return;
    if (!file) throw new Error('应用数据目录不可用。');
    try { session = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (failure) { if (failure.code !== 'ENOENT') throw new Error('服务器登录信息读取失败，请检查应用数据目录。'); }
    loaded = true;
    monitorAccount();
  }
  async function save(value) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    session = value;
  }
  async function api(server, route, { method = 'POST', body, token } = {}) {
    const response = await fetch(server + route, {
      method, redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `服务器请求失败 (${response.status})`), { status: response.status, code: data.error, interval: data.interval });
    return data;
  }
  function status() { return { loggedIn: Boolean(session?.accessToken && session.expiresAt > Date.now()), username: session?.username || '', serverUrl: session?.serverUrl || '', online }; }
  function changed() { onStatus(status()); }
  async function acceptLogin(serverUrl, result) {
    if (typeof result.username !== 'string' || typeof result.accessToken !== 'string' || result.accessToken.length < 32 || !Number.isFinite(result.expiresAt)) throw new Error('服务器返回的登录信息不完整。');
    if (session?.deviceId && (session.serverUrl !== serverUrl || session.username !== result.username)) throw new Error('请先退出当前服务器账号，再切换账号。');
    let registration = session?.serverUrl === serverUrl && session.username === result.username ? { deviceId: session.deviceId, deviceSecret: session.deviceSecret, desktopIdentity: session.desktopIdentity } : {};
    if (registration.deviceId) {
      try { await api(serverUrl, '/relay/device-session', { token: result.accessToken, body: { deviceId: registration.deviceId, deviceSecret: registration.deviceSecret } }); }
      catch (failure) { if (failure.status === 404) registration = {}; else throw failure; }
    }
    const resume = wanted && target?.serverUrl === serverUrl && Boolean(registration.deviceId);
    modelGateway.invalidate(); stop(); await save({ serverUrl, username: result.username, accessToken: result.accessToken, expiresAt: result.expiresAt, ...registration });
    if (resume) { wanted = true; await connect(generation); }
    monitorAccount(); changed(); return status();
  }
  async function verifySession() {
    if (!session?.accessToken || session.expiresAt <= Date.now()) return;
    try {
      const result = await api(session.serverUrl, '/relay/account', { method: 'GET', token: session.accessToken });
      if (result.username !== session.username) throw new Error('服务器账号不一致，请重新登录。');
      if (session.expiresAt - Date.now() < 86400000) {
        const refreshed = await api(session.serverUrl, '/relay/refresh', { token: session.accessToken });
        await save({ ...session, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt });
      }
    } catch (failure) {
      if (failure.status === 401) { modelGateway.invalidate(); stopAccountMonitor(); stop(); await fs.rm(file, { force: true }); session = undefined; changed(); }
      else throw failure;
    }
  }
  function send(frame, active = socket) {
    if (active !== socket || active?.readyState !== WebSocket.OPEN) return;
    if (active.bufferedAmount > 20 * 1024 * 1024) { active.terminate(); return; }
    active.send(JSON.stringify(frame));
  }
  function clearLocal() {
    for (const controller of requests.values()) controller.abort(); requests.clear();
    for (const entry of channels.values()) { entry.controller.abort(); entry.socket?.terminate(); } channels.clear();
  }
  function stop() {
    wanted = false; generation++; clearTimeout(timer); timer = undefined;
    const old = socket; socket = undefined; connecting = undefined; old?.terminate(); clearLocal(); online = false; changed();
  }
  async function forward(frame, active) {
    if (requests.size >= 8 || requests.has(frame.id) || !allowedRelayRoute(frame.method, frame.path)) {
      send({ type: 'relay.response', id: frame.id, status: 400, body: Buffer.from('{"error":"Unsupported or busy Desktop request."}').toString('base64') }, active); return;
    }
    const controller = new AbortController(); requests.set(frame.id, controller);
    const deadline = setTimeout(() => controller.abort(), 40000);
    try {
      const response = await fetch(target.baseUrl + frame.path, { method: frame.method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${target.token}`, ...(frame.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        body: frame.method === 'POST' ? JSON.stringify(frame.body ?? {}) : undefined });
      const parts = []; let length = 0;
      for await (const part of response.body || []) { length += part.length; if (length > 13 * 1024 * 1024) { controller.abort(); throw new Error('Response too large'); } parts.push(part); }
      if (controller.signal.aborted) return;
      send({ type: 'relay.response', id: frame.id, status: response.status,
        headers: { 'content-type': response.headers.get('content-type') || 'application/octet-stream', 'content-disposition': response.headers.get('content-disposition') || '' },
        body: Buffer.concat(parts).toString('base64') }, active);
    } catch {
      if (!controller.signal.aborted) send({ type: 'relay.response', id: frame.id, status: 502, body: Buffer.from('{"error":"Desktop request failed. Check its state before repeating the action."}').toString('base64') }, active);
    } finally { clearTimeout(deadline); if (requests.get(frame.id) === controller) requests.delete(frame.id); }
  }
  async function openChannel(id, active) {
    if (channels.has(id) || channels.size >= 16) return send({ type: 'relay.channelClosed', channelId: id }, active);
    const entry = { controller: new AbortController(), socket: null }; channels.set(id, entry);
    try {
      const response = await fetch(target.baseUrl + '/v1/socket-ticket', { method: 'POST', headers: { Authorization: `Bearer ${target.token}` }, signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(10000)]) });
      const data = await response.json();
      if (!response.ok || typeof data.ticket !== 'string') throw new Error('No local ticket');
      if (channels.get(id) !== entry || socket !== active) return;
      const url = new URL(target.baseUrl + '/v1/events'); url.protocol = 'ws:'; url.searchParams.set('ticket', data.ticket);
      const local = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false }); entry.socket = local;
      local.on('error', () => {});
      local.on('message', bytes => { if (channels.get(id) === entry) send({ type: 'relay.event', channelId: id, data: bytes.toString() }, active); });
      local.on('close', () => { if (channels.get(id) === entry) { channels.delete(id); send({ type: 'relay.channelClosed', channelId: id }, active); } });
    } catch { if (channels.get(id) === entry) { channels.delete(id); send({ type: 'relay.channelClosed', channelId: id }, active); } }
  }
  function connect(scope) {
    if (!wanted || scope !== generation) return Promise.resolve(false);
    if (online && socket?.readyState === WebSocket.OPEN) return Promise.resolve(true);
    if (connecting?.scope === scope) return connecting.promise;
    clearTimeout(timer); timer = undefined;
    const attempt = { scope, promise: null };
    connecting = attempt;
    attempt.promise = new Promise(resolve => {
      const url = new URL(session.serverUrl + '/relay/desktop'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const active = new WebSocket(url, { headers: { Authorization: `Bearer ${session.deviceSecret}`, 'X-Trylo-Device': session.deviceId }, handshakeTimeout: 10000, maxPayload: 1024 * 1024, perMessageDeflate: false });
      socket = active;
      let lastSeenAt = Date.now();
      const heartbeat = setInterval(() => {
        if (active !== socket || scope !== generation) return;
        if (Date.now() - lastSeenAt >= heartbeatTimeoutMs) { active.terminate(); return; }
        if (active.readyState === WebSocket.OPEN) active.ping();
      }, heartbeatIntervalMs);
      heartbeat.unref?.();
      active.on('ping', () => { lastSeenAt = Date.now(); });
      active.on('pong', () => { lastSeenAt = Date.now(); });
      let settled = false;
      const finish = value => { if (!settled) { settled = true; clearTimeout(deadline); resolve(value); } };
      const deadline = setTimeout(() => { finish(false); active.terminate(); }, 12000);
      active.on('error', () => {});
      active.on('message', bytes => {
        if (active !== socket || scope !== generation) return;
        lastSeenAt = Date.now();
        let frame; try { frame = JSON.parse(bytes.toString()); } catch { active.close(1008); return; }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) { active.close(1008); return; }
        if (frame.type === 'relay.ready') { online = true; delay = 1000; changed(); finish(true); }
        else if (online && frame.type === 'relay.request') void forward(frame, active);
        else if (frame.type === 'relay.cancel') requests.get(frame.id)?.abort();
        else if (online && frame.type === 'relay.open') void openChannel(frame.channelId, active);
        else if (frame.type === 'relay.close') { const entry = channels.get(frame.channelId); channels.delete(frame.channelId); entry?.controller.abort(); entry?.socket?.terminate(); }
      });
      active.on('close', () => {
        clearInterval(heartbeat);
        finish(false);
        if (active !== socket || scope !== generation) return;
        online = false; clearLocal(); changed();
        if (wanted) { timer = setTimeout(() => { void connect(scope); }, delay); delay = Math.min(delay * 2, 15000); }
      });
    }).finally(() => { if (connecting === attempt) connecting = undefined; });
    return attempt.promise;
  }
  return {
    status: () => serialize(async () => { await load(); await verifySession(); return status(); }),
    models: () => modelList(),
    modelConnection: params => modelGateway.connection(params),
    close: async () => { stopAccountMonitor(); stop(); await modelGateway.close(); },
    beginBrowserLogin: params => {
      const browserScope = ++browserGeneration;
      browserLogin = undefined;
      return serialize(async () => {
      await load();
      if (browserScope !== browserGeneration) throw new Error('浏览器登录已取消。');
      const serverUrl = relayUrl(params.serverUrl, allowLocal);
      const verifier = crypto.randomBytes(32).toString('base64url');
      const result = await api(serverUrl, '/relay/auth/start', { body: { challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), name: 'Trylo Desktop' } });
      const url = new URL(result.verificationUrl);
      const expectedOrigin = serverUrl === 'https://relay.trylocode.me' ? 'https://trylocode.me' : serverUrl;
      if (url.origin !== expectedOrigin || url.pathname !== '/account/' || !/^#authorize\?code=[A-F0-9]{12}$/.test(url.hash) || url.username || url.password || url.search || !Number.isFinite(result.expiresAt) || typeof result.deviceCode !== 'string') throw new Error('服务器返回的浏览器登录地址无效。');
      if (browserScope !== browserGeneration) throw new Error('浏览器登录已取消。');
      const id = crypto.randomUUID(); browserLogin = { ...result, verificationUrl: url.href, id, serverUrl, verifier };
      let browserOpened = params.openBrowser !== false;
      if (browserOpened) {
        try { await openBrowser(url.href); } catch { browserOpened = false; }
      }
      return { id, verificationUrl: url.href, userCode: result.userCode, expiresAt: result.expiresAt, interval: result.interval, browserOpened };
      });
    },
    openBrowserLogin: async params => {
      const attempt = browserLogin;
      if (!attempt || params.id !== attempt.id || attempt.expiresAt <= Date.now()) throw new Error('浏览器登录已过期，请重新发起。');
      await openBrowser(attempt.verificationUrl);
      return { ok: true };
    },
    openAccountCenter: () => serialize(async () => {
      await load(); await verifySession();
      if (!status().loggedIn) throw new Error('请先登录 Trylo 账号。');
      const origin = session.serverUrl === 'https://relay.trylocode.me' ? 'https://trylocode.me' : relayUrl(session.serverUrl, allowLocal);
      await openBrowser(new URL('/account/', origin).href);
      return { ok: true };
    }),
    pollBrowserLogin: params => serialize(async () => {
      const attempt = browserLogin;
      if (!attempt || params.id !== attempt.id || attempt.expiresAt <= Date.now()) throw new Error('浏览器登录已过期，请重新发起。');
      try {
        const result = await api(attempt.serverUrl, '/relay/auth/poll', { body: { deviceCode: attempt.deviceCode, verifier: attempt.verifier } });
        if (browserLogin !== attempt) { await api(attempt.serverUrl, '/relay/logout', { token: result.accessToken }).catch(() => {}); throw new Error('浏览器登录已取消。'); }
        const account = await acceptLogin(attempt.serverUrl, result);
        if (browserLogin !== attempt) { stopAccountMonitor(); stop(); await api(attempt.serverUrl, '/relay/logout', { token: result.accessToken }).catch(() => {}); await fs.rm(file, { force: true }); session = undefined; throw new Error('浏览器登录已取消。'); }
        browserLogin = undefined; return { status: 'complete', account };
      } catch (failure) {
        if (['authorization_pending', 'slow_down'].includes(failure.code)) return { status: 'pending', interval: failure.interval || attempt.interval };
        browserLogin = undefined; throw failure;
      }
    }),
    cancelBrowserLogin: () => { ++browserGeneration; browserLogin = undefined; return { ok: true }; },
    login: params => serialize(async () => {
      await load(); const serverUrl = relayUrl(params.serverUrl, allowLocal);
      const result = await api(serverUrl, params.register ? '/relay/register' : '/relay/login', { body: { username: params.username, password: params.password, inviteCode: params.inviteCode } });
      browserLogin = undefined; return acceptLogin(serverUrl, result);
    }),
    logout: () => serialize(async () => {
      await load(); browserLogin = undefined; modelGateway.invalidate(); stopAccountMonitor(); stop();
      if (session?.accessToken && session.deviceId) {
        try { await api(session.serverUrl, `/relay/devices/${session.deviceId}`, { method: 'DELETE', token: session.accessToken }); }
        catch (failure) { if (![401, 404].includes(failure.status)) throw failure; }
      }
      if (session?.accessToken) {
        try { await api(session.serverUrl, '/relay/logout', { token: session.accessToken }); }
        catch (failure) { if (failure.status !== 401) throw failure; }
      }
      await fs.rm(file, { force: true }); session = undefined; changed(); return status();
    }),
    enable: value => serialize(async () => {
      await load(); stop(); await verifySession();
      if (!status().loggedIn) throw new Error('请先在远程设置中登录服务器账号。');
      if (relayUrl(value.serverUrl, allowLocal) !== session.serverUrl) throw new Error('服务器地址与当前登录不一致，请重新登录。');
      const localUrl = new URL(value.baseUrl);
      if (localUrl.protocol !== 'http:' || localUrl.hostname !== '127.0.0.1' || localUrl.pathname !== '/' || localUrl.username || localUrl.password || localUrl.search || localUrl.hash) throw new Error('Invalid local gateway');
      target = { ...value };
      if (!session.deviceId || session.desktopIdentity !== value.deviceId) {
        const registration = await api(session.serverUrl, '/relay/devices', { token: session.accessToken, body: { name: value.deviceName, desktopIdentity: value.deviceId } });
        await save({ ...session, ...registration, desktopIdentity: value.deviceId });
      }
      wanted = true; const scope = generation;
      await connect(scope); return status();
    }),
    disable: async () => { stop(); },
    pairing: async () => {
      if (!status().loggedIn) throw new Error('服务器登录已过期，请重新登录后生成二维码。');
      if (!wanted || !target) throw new Error('请先启用服务器远程连接。');
      // A QR refresh joins (or advances) the existing reconnect attempt. It
      // must not tear down the gateway, device registration or phone streams.
      if (!online && !await connect(generation)) throw new Error('服务器连接暂时中断，正在自动重连。请稍后重试生成二维码。');
      const current = socket;
      let data;
      try { data = await api(session.serverUrl, `/relay/devices/${session.deviceId}/pairing`, { token: session.accessToken }); }
      catch (failure) {
        if (failure.status === 401) throw new Error('服务器登录已过期，请重新登录后生成二维码。');
        if (!failure.status || failure.status >= 500) throw new Error('暂时无法访问服务器，二维码尚未生成。请检查网络后重试。');
        throw failure;
      }
      if (socket !== current || !online) throw new Error('连接已变化，请重新生成二维码。');
      const pairing = { protocol: 1, service: 'trylo-remote', connectionMode: 'server', relayDeviceId: session.deviceId,
        deviceId: target.deviceId, deviceName: target.deviceName, workspaceName: target.workspaceName,
        baseUrl: session.serverUrl, token: data.ticket, expiresAt: data.expiresAt };
      return { pairing, qrDataUrl: await qrcode.toDataURL(JSON.stringify(pairing)) };
    },
  };
}

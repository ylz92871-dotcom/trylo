import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
export const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const fail = (status, message) => Object.assign(new Error(message), { status });
const day = 86400000;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const userView = user => ({ id: user.id, username: user.username, role: user.role || 'user', createdAt: user.createdAt || null, disabled: Boolean(user.disabled) });

// One identity ledger is shared by website and native relay clients. Cookies and
// native credentials are deliberately different session kinds and cannot cross scopes.
export async function createAccounts({ store, now, origin, secureCookies = true, limited, json, body, online, removeDevice, modelService }) {
  const webOrigin = new URL(origin).origin;
  const names = { web: secureCookies ? '__Host-trylo-web' : 'trylo-web', admin: secureCookies ? '__Host-trylo-admin' : 'trylo-admin' };
  await store.change(state => {
    state.invitations ??= []; state.grants ??= []; state.audit ??= []; state.usage ??= [];
    state.limits ??= { registrationOpen: true, maxAccounts: 1000, maxDevices: 10 };
    if (!state.accountSchema) {
      // Legacy account tokens had no device binding. Bind the unambiguous
      // one-computer case; require re-login rather than guess for other cases.
      state.sessions = state.sessions.filter(session => {
        if (session.kind !== 'account' || session.deviceId) return true;
        const owned = state.devices.filter(device => device.userId === session.userId);
        if (owned.length === 1) { session.deviceId = owned[0].id; return true; }
        return owned.length === 0;
      });
      state.accountSchema = 1;
    }
  });
  let hashing = 0;
  function audit(state, actor, action, target) {
    state.audit.push({ id: crypto.randomUUID(), at: now(), actor, action, target });
    if (state.audit.length > 5000) state.audit.splice(0, state.audit.length - 5000);
  }
  function session(state, userId, kind) {
    const value = token(), expiresAt = now() + (kind === 'admin' ? day / 12 : 7 * day);
    state.sessions = state.sessions.filter(item => item.expiresAt > now());
    if (state.sessions.length >= 10000 || state.sessions.filter(item => item.userId === userId && item.kind === kind).length >= 30) throw fail(429, '登录会话过多，请先退出不用的会话。');
    state.sessions.push({ hash: digest(value), userId, kind, expiresAt, createdAt: now() });
    return { accessToken: value, expiresAt };
  }
  function cookie(response, kind, value = '', expiresAt = 0) {
    response.setHeader('Set-Cookie', `${names[kind]}=${value}; Path=/; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}; Max-Age=${Math.max(0, Math.floor((expiresAt - now()) / 1000))}`);
  }
  const csrf = principal => digest(`${principal.hash}:csrf`);
  function principal(request, kind) {
    const cookies = String(request.headers.cookie || '').split(';').map(item => item.trim().split('='));
    const values = cookies.filter(([name]) => name === names[kind]);
    if (values.length !== 1 || !/^[\w-]{43}$/.test(values[0][1] || '')) throw fail(401, '请先登录。');
    const state = store.read();
    const entry = state.sessions.find(item => item.kind === kind && equal(item.hash, digest(values[0][1])) && item.expiresAt > now());
    const user = entry && state.users.find(item => item.id === entry.userId && !item.disabled);
    if (!entry || !user) throw fail(401, '登录已过期，请重新登录。');
    if (kind === 'admin' && user.role !== 'admin') throw fail(403, '需要管理员权限。');
    return { ...entry, user };
  }
  function mutation(request, entry) {
    if (request.headers.origin !== webOrigin || request.headers['content-type']?.split(';')[0] !== 'application/json') throw fail(403, '请求来源不受信任。');
    if (entry && !equal(request.headers['x-csrf-token'], csrf(entry))) throw fail(403, '页面会话已变化，请刷新后重试。');
  }
  function consumeInvite(state, value, username) {
    const invite = state.invitations.find(item => equal(item.hash, digest(String(value || ''))));
    if (!state.limits.registrationOpen || state.users.length >= state.limits.maxAccounts) throw fail(403, '暂时停止接收新账号。');
    if (!invite || invite.revokedAt || invite.expiresAt <= now() || invite.used >= invite.limit) throw fail(403, '邀请码无效、已到期或名额已用完。');
    if (invite.boundUsername && invite.boundUsername !== username) throw fail(403, '此邀请仅供指定账号使用。');
    if (state.users.some(user => user.username === username)) throw fail(409, '账号名已被使用。');
    invite.used++; return invite;
  }
  async function credentials(data, register, kind) {
    const username = String(data.username || '').trim().toLowerCase(), password = String(data.password || '');
    if (!/^[a-z0-9_.-]{3,64}$/.test(username) || password.length < 12 || password.length > 256) throw fail(400, '账号为 3–64 位字母、数字或 ._-，密码至少 12 位。');
    if (hashing >= 2) throw fail(429, '登录服务繁忙，请稍后再试。');
    hashing++;
    try {
      if (register) {
        const salt = crypto.randomBytes(16).toString('hex');
        const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
        return await store.change(state => {
          const invite = consumeInvite(state, data.inviteCode, username);
          const user = { id: crypto.randomUUID(), username, salt, passwordHash, createdAt: now(), role: 'user', allowance: invite.allowance || 0 };
          state.users.push(user); audit(state, user.id, 'account.register', invite.id);
          return { user: userView(user), ...session(state, user.id, kind) };
        });
      }
      const user = store.read().users.find(item => item.username === username);
      const candidate = (await scrypt(password, user?.salt || 'unavailable-user', 64)).toString('hex');
      if (!user || user.disabled || !equal(candidate, user.passwordHash)) throw fail(401, '账号或密码不正确。');
      return await store.change(state => {
        const current = state.users.find(item => item.id === user.id && !item.disabled);
        if (!current || !equal(current.passwordHash, candidate)) throw fail(401, '账号状态已变化。');
        if (kind === 'admin' && current.role !== 'admin') throw fail(403, '此账号没有管理员权限。');
        return { user: userView(current), ...session(state, current.id, kind) };
      });
    } finally { hashing--; }
  }
  function quota(state, userId) {
    const user = state.users.find(item => item.id === userId);
    const used = state.usage.filter(item => item.userId === userId).reduce((sum, item) => sum + item.units, 0);
    return { total: user.allowance || 0, used, remaining: Math.max(0, (user.allowance || 0) - used), unit: '点', modelServiceEnabled: false };
  }
  function deviceList(userId) {
    return store.read().devices.filter(item => item.userId === userId).map(item => ({ id: item.id, name: item.name, online: online(item.id), desktopIdentity: item.desktopIdentity }));
  }
  async function handle(request, response, url) {
    const route = url.pathname, method = request.method;
    if (route === '/relay/auth/start' && method === 'POST') {
      limited(`device-start:${request.socket.remoteAddress}`, 12);
      const data = await body(request);
      if (!/^[\w-]{43}$/.test(data.challenge || '')) throw fail(400, 'Invalid authorization challenge.');
      const deviceCode = token(), userCode = crypto.randomBytes(6).toString('hex').toUpperCase();
      const expiresAt = now() + 10 * 60000;
      await store.change(state => {
        state.grants = state.grants.filter(item => item.expiresAt > now());
        if (state.grants.length >= 1000) throw fail(429, '登录请求过多。');
        state.grants.push({ hash: digest(deviceCode), userCode, challenge: data.challenge, name: String(data.name || 'Trylo Desktop').slice(0, 80), expiresAt, interval: 5000, nextPollAt: now() + 5000, status: 'pending' });
      });
      return json(response, 201, { deviceCode, userCode, expiresAt, interval: 5000, verificationUrl: `${webOrigin}/account/#authorize?code=${userCode}` });
    }
    if (route === '/relay/auth/poll' && method === 'POST') {
      limited(`device-poll:${request.socket.remoteAddress}`, 60);
      const data = await body(request);
      const result = await store.change(state => {
        const entry = state.grants.find(item => equal(item.hash, digest(data.deviceCode)));
        if (!entry || entry.expiresAt <= now()) return { status: 400, error: 'expired_token' };
        if (!/^[\w-]{43,128}$/.test(data.verifier || '') || !equal(crypto.createHash('sha256').update(data.verifier).digest('base64url'), entry.challenge)) return { status: 400, error: 'invalid_grant' };
        if (entry.nextPollAt > now()) { entry.interval = Math.min(entry.interval + 5000, 60000); entry.nextPollAt = now() + entry.interval; return { status: 400, error: 'slow_down', interval: entry.interval }; }
        entry.nextPollAt = now() + entry.interval;
        if (entry.status === 'pending') return { status: 400, error: 'authorization_pending' };
        state.grants = state.grants.filter(item => item !== entry);
        const user = state.users.find(item => item.id === entry.userId && !item.disabled);
        if (entry.status !== 'approved' || !user) return { status: 400, error: 'access_denied' };
        audit(state, user.id, 'desktop.login', entry.name);
        return { status: 200, username: user.username, ...session(state, user.id, 'account') };
      });
      const { status, ...value } = result; return json(response, status, value);
    }
    if (!route.startsWith('/api/')) return false;
    const kind = route.startsWith('/api/admin/') ? 'admin' : 'web';
    const prefix = kind === 'admin' ? '/api/admin' : '/api/account';
    if (method === 'POST' && [`${prefix}/login`, `${prefix}/register`].includes(route)) {
      mutation(request); limited(`web-auth:${request.socket.remoteAddress}`, 12);
      if (kind === 'admin' && route.endsWith('/register')) throw fail(404, '管理后台不开放注册。');
      const result = await credentials(await body(request), route.endsWith('/register'), kind);
      cookie(response, kind, result.accessToken, result.expiresAt);
      return json(response, route.endsWith('/register') ? 201 : 200, { user: result.user, expiresAt: result.expiresAt });
    }
    const entry = principal(request, kind);
    if (method !== 'GET') { mutation(request, entry); limited(`mutation:${entry.hash}`, 40); }
    if (modelService && kind === 'admin' && await modelService.handleAdmin(request, response, url, entry, { body, json })) return;
    if (modelService && kind === 'web' && await modelService.handleUser(request, response, url, entry, { body, json })) return;
    if (route === `${prefix}/session` && method === 'GET') return json(response, 200, { user: userView(entry.user), csrf: csrf(entry), expiresAt: entry.expiresAt });
    if (route === `${prefix}/logout` && method === 'POST') {
      await store.change(state => { state.sessions = state.sessions.filter(item => item.hash !== entry.hash); });
      cookie(response, kind); return json(response, 200, { ok: true });
    }
    if (kind === 'web') {
      if (route === '/api/account/summary' && method === 'GET') return json(response, 200, { user: userView(entry.user), quota: quota(store.read(), entry.userId), devices: deviceList(entry.userId) });
      if (route === '/api/account/usage' && method === 'GET') return json(response, 200, { records: store.read().usage.filter(item => item.userId === entry.userId).slice(-200).map(({ userId, ...item }) => item) });
      if (route === '/api/account/models' && method === 'GET') return json(response, 200, { enabled: false, models: [], reason: '统一模型服务尚未开放，当前不会产生模型费用。' });
      if (route === '/api/account/devices' && method === 'GET') return json(response, 200, { devices: deviceList(entry.userId) });
      const removal = route.match(/^\/api\/account\/devices\/([a-f0-9-]+)$/);
      if (removal && method === 'DELETE') { await removeDevice(entry, removal[1]); return json(response, 200, { ok: true }); }
      if (route === '/api/account/authorization' && method === 'GET') {
        const grant = store.read().grants.find(item => item.userCode === url.searchParams.get('code') && item.expiresAt > now() && item.status === 'pending');
        if (!grant) throw fail(410, '登录请求已过期或已处理，请从 Desktop 重新发起。');
        return json(response, 200, { name: grant.name, userCode: grant.userCode, expiresAt: grant.expiresAt });
      }
      if (route === '/api/account/authorization' && method === 'POST') {
        const data = await body(request);
        if (typeof data.approve !== 'boolean') throw fail(400, '请选择确认或取消。');
        await store.change(state => {
          const grant = state.grants.find(item => item.userCode === data.code && item.expiresAt > now() && item.status === 'pending');
          if (!grant) throw fail(410, '登录请求已过期或已处理。');
          grant.status = data.approve ? 'approved' : 'denied'; grant.userId = entry.userId;
        });
        return json(response, 200, { ok: true });
      }
    } else {
      if (route === '/api/admin/invitations' && method === 'GET') return json(response, 200, { invitations: store.read().invitations.map(({ hash, ...item }) => item) });
      if (route === '/api/admin/invitations' && method === 'POST') {
        const data = await body(request), limit = Number(data.limit), days = Number(data.days);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(days) || days < 1 || days > 90) throw fail(400, '名额为 1–100 人，有效期为 1–90 天。');
        const code = `TRYLO-${crypto.randomBytes(18).toString('base64url')}`;
        const item = await store.change(state => {
          if (state.invitations.length >= 10000) throw fail(429, '邀请记录容量已达上限。');
          const record = { id: crypto.randomUUID(), hash: digest(code), suffix: code.slice(-6), note: String(data.note || '').slice(0, 120), limit, used: 0, createdAt: now(), expiresAt: now() + days * day, issuer: entry.userId, allowance: 0 };
          state.invitations.push(record); audit(state, entry.userId, 'invite.create', record.id);
          const { hash, ...view } = record; return view;
        });
        return json(response, 201, { invitation: item, code });
      }
      const revocation = route.match(/^\/api\/admin\/invitations\/([a-f0-9-]+)$/);
      if (revocation && method === 'DELETE') {
        await store.change(state => { const item = state.invitations.find(item => item.id === revocation[1]); if (!item) throw fail(404, '邀请不存在。'); item.revokedAt = now(); audit(state, entry.userId, 'invite.revoke', item.id); });
        return json(response, 200, { ok: true });
      }
      if (route === '/api/admin/users' && method === 'GET') { const state = store.read(); return json(response, 200, { users: state.users.map(user => ({ ...userView(user), quota: quota(state, user.id), devices: state.devices.filter(item => item.userId === user.id).length })) }); }
      if (route === '/api/admin/limits' && method === 'GET') return json(response, 200, { ...store.read().limits, modelServiceEnabled: false });
      if (route === '/api/admin/limits' && method === 'POST') {
        const data = await body(request);
        if (typeof data.registrationOpen !== 'boolean' || !Number.isInteger(data.maxAccounts) || data.maxAccounts < 1 || data.maxAccounts > 1000 || !Number.isInteger(data.maxDevices) || data.maxDevices < 1 || data.maxDevices > 50) throw fail(400, '账号上限 1–1000，单账号设备上限 1–50。');
        await store.change(state => { state.limits = { registrationOpen: data.registrationOpen, maxAccounts: data.maxAccounts, maxDevices: data.maxDevices }; audit(state, entry.userId, 'limits.update', 'platform'); });
        return json(response, 200, { ok: true });
      }
      if (route === '/api/admin/audit' && method === 'GET') return json(response, 200, { records: store.read().audit.slice(-200).reverse().map(item => ({ ...item, actor: store.read().users.find(user => user.id === item.actor)?.username || item.actor })) });
    }
    throw fail(404, '接口不存在。');
  }
  return { handle, credentials, consumeInvite };
}

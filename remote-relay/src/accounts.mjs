import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createMfa } from './mfa.mjs';
import { validateNewPassword } from './password-policy.mjs';

const scrypt = promisify(crypto.scrypt);
export const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const day = 86400000;
// OWASP's 32 MiB scrypt profile; the shared two-job cap bounds memory use.
// Versionless records retain the old Node defaults and migrate after login.
const passwordVersion = 2;
const passwordOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const userView = user => ({ id: user.id, username: user.username, role: user.role || 'user', createdAt: user.createdAt || null, disabled: Boolean(user.disabled) });

export function isAccountRoute(method, pathname) {
  if (method === 'GET') return /^\/api\/(account\/(session|summary|usage|models|devices|authorization|model-quotas|model-usage)|admin\/(session|invitations|users|limits|audit|security|model-service(?:\/requests)?)|(account|admin)\/mfa\/status)$/.test(pathname);
  if (method === 'POST' && pathname === '/api/admin/mfa/verify') return true;
  if (method === 'POST') return /^\/relay\/auth\/(start|poll)$/.test(pathname) || /^\/api\/(account\/(login|register|logout|password|sessions\/revoke|authorization|model-requests)|admin\/(login|register|logout|invitations|limits)|(account|admin)\/mfa\/(enroll|confirm|recovery\/rotate|disable))$/.test(pathname) || /^\/api\/admin\/model-service\/(upstreams|grants|upstreams\/[a-f0-9-]+\/(credential|catalog|enabled)|requests\/[a-f0-9-]+\/reconcile)$/.test(pathname);
  return method === 'DELETE' && /^\/api\/(account\/devices|admin\/invitations|admin\/model-service\/grants)\/[a-f0-9-]+$/.test(pathname);
}

// Fixed recovery/setup routes get an independent opportunity to authenticate.
// Business operations, native bearer routes and public login are excluded.
export function isAccountSecurityRoute(method, pathname) {
  if (method === 'POST' && pathname === '/api/admin/mfa/verify') return true;
  if (method === 'GET') return /^\/api\/(account|admin)\/(session|mfa\/status)$/.test(pathname);
  return method === 'POST' && (/^\/api\/(account|admin)\/(logout|mfa\/(enroll|confirm|recovery\/rotate|disable))$/.test(pathname) || /^\/api\/account\/(password|sessions\/revoke)$/.test(pathname));
}

// One identity ledger is shared by website and native relay clients. Cookies and
// native credentials are deliberately different session kinds and cannot cross scopes.
export async function createAccounts({ store, now, origin, secureCookies = true, limited, json, body, online, removeDevice, modelService, mfaDirectory, securityEvent = () => {}, securityStatus = () => ({}), admitOwner = () => {}, admitSecurity = () => {}, clientAddress = request => request.socket.remoteAddress, revokeUser = () => {} }) {
  const webOrigin = new URL(origin).origin;
  const mfa = await createMfa({ directory: mfaDirectory, store, now });
  const names = { web: secureCookies ? '__Host-trylo-web' : 'trylo-web', admin: secureCookies ? '__Host-trylo-admin' : 'trylo-admin' };
  await store.change(state => {
    state.invitations ??= []; state.grants ??= []; state.audit ??= []; state.usage ??= [];
    state.mfaEnrollments ??= [];
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
    if (!state.accountMfaSchema) {
      const administrators = new Set(state.users.filter(user => user.role === 'admin').map(user => user.id));
      for (const entry of state.sessions) if (administrators.has(entry.userId)) {
        entry.restricted = true; entry.mfaVerified = false;
        entry.expiresAt = Math.min(entry.expiresAt, now() + 600000);
        entry.lastSeenAt = now();
      }
      state.devices = state.devices.filter(item => !administrators.has(item.userId));
      state.grants = state.grants.filter(item => !administrators.has(item.userId));
      state.accountMfaSchema = 1;
    }
  });
  let hashing = 0, loginHashing = 0;
  function event(type, address, username, outcome) { securityEvent({ type: type.replaceAll('/', '.'), address, subject: digest(username.trim().toLowerCase()), outcome }); }
  function mfaState(user, entry) {
    const enabled = Boolean(user.mfa?.secret), required = user.role === 'admin';
    return { verificationRequired: Boolean(enabled && entry?.kind === 'admin' && !entry.mfaVerified), enabled, required, restricted: Boolean(entry?.restricted || ((enabled || required) && (!enabled || !entry?.mfaVerified))), recoveryCodesRemaining: user.mfa?.recoveryHashes?.length || 0 };
  }
  function takeHashing(login = false) {
    if (hashing >= 2 || (login && loginHashing >= 1)) throw fail(429, '登录服务繁忙，请稍后再试。');
    hashing++; if (login) loginHashing++;
    return () => { hashing--; if (login) loginHashing--; };
  }
  function audit(state, actor, action, target) {
    state.audit.push({ id: crypto.randomUUID(), at: now(), actor, action, target });
    if (state.audit.length > 5000) state.audit.splice(0, state.audit.length - 5000);
  }
  function session(state, userId, kind, { restricted = false, mfaVerified = false } = {}) {
    const value = token(), expiresAt = now() + (restricted ? 600000 : kind === 'admin' ? day / 12 : 7 * day);
    state.sessions = state.sessions.filter(item => item.expiresAt > now());
    if (state.sessions.length >= 10000 || state.sessions.filter(item => item.userId === userId && item.kind === kind).length >= 30) throw fail(429, '登录会话过多，请先退出不用的会话。');
    const entry = { hash: digest(value), userId, kind, expiresAt, createdAt: now(), authenticatedAt: now(), absoluteExpiresAt: now() + (kind === 'admin' ? day / 12 : 30 * day), lastSeenAt: now(), restricted, mfaVerified };
    state.sessions.push(entry);
    return { accessToken: value, expiresAt, mfa: mfaState(state.users.find(user => user.id === userId), entry) };
  }
  function cookie(response, kind, value = '', expiresAt = 0) {
    response.setHeader('Set-Cookie', `${names[kind]}=${value}; Path=/; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}; Max-Age=${Math.max(0, Math.floor((expiresAt - now()) / 1000))}`);
  }
  const csrf = principal => digest(`${principal.hash}:csrf`);
  function requireCurrent(state, entry) {
    const user = state.users.find(item => item.id === entry.userId && !item.disabled);
    if (!user || !state.sessions.some(item => item.hash === entry.hash && item.kind === entry.kind && item.userId === user.id && item.expiresAt > now() && (item.absoluteExpiresAt === undefined || item.absoluteExpiresAt > now()) && (item.kind !== 'admin' || (item.lastSeenAt ?? item.createdAt ?? 0) + 15 * 60000 > now()))) throw fail(401, '登录已过期，请重新登录。');
    if (entry.kind === 'admin' && user.role !== 'admin') throw fail(403, '需要管理员权限。');
    return user;
  }
  function principal(request, kind) {
    const cookies = String(request.headers.cookie || '').split(';').map(item => {
      const separator = item.indexOf('=');
      return [item.slice(0, separator).trim(), item.slice(separator + 1)];
    });
    const values = cookies.filter(([name]) => name === names[kind]);
    if (values.length !== 1 || !/^[\w-]{43}$/.test(values[0][1] || '')) throw fail(401, '请先登录。');
    const state = store.read();
    const entry = state.sessions.find(item => item.kind === kind && equal(item.hash, digest(values[0][1])) && item.expiresAt > now());
    const user = entry && state.users.find(item => item.id === entry.userId && !item.disabled);
    if (!entry || !user) throw fail(401, '登录已过期，请重新登录。');
    requireCurrent(state, entry);
    if (kind === 'admin' && user.role !== 'admin') throw fail(403, '需要管理员权限。');
    return { ...entry, user };
  }
  function mutation(request, entry) {
    if (request.headers.origin !== webOrigin || request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw fail(403, '请求来源不受信任。');
    if (entry && !equal(request.headers['x-csrf-token'], csrf(entry))) throw fail(403, '页面会话已变化，请刷新后重试。');
  }
  function checkedInvite(state, value, username) {
    if (typeof value !== 'string' || !value.length || value.length > 256) throw fail(403, '邀请码无效、已到期或名额已用完。');
    const invite = state.invitations.find(item => equal(item.hash, digest(value)));
    if (!state.limits.registrationOpen || state.users.length >= state.limits.maxAccounts) throw fail(403, '暂时停止接收新账号。');
    if (!invite || invite.revokedAt || invite.expiresAt <= now() || invite.used >= invite.limit) throw fail(403, '邀请码无效、已到期或名额已用完。');
    if (invite.boundUsername && invite.boundUsername !== username) throw fail(403, '此邀请仅供指定账号使用。');
    if (state.users.some(user => user.username === username)) throw fail(409, '账号名已被使用。');
    return invite;
  }
  function consumeInvite(state, value, username) {
    const invite = checkedInvite(state, value, username);
    invite.used++; return invite;
  }
  function credentialLimit(username, address) {
    // Source-scoped budgets cannot let an anonymous third party globally lock
    // a known account or prevent an authenticated user revoking stolen sessions.
    limited(`credential:${digest(username.trim().toLowerCase())}:${address}`, 10);
  }
  async function hashPassword(password, salt, version = passwordVersion) {
    return (await scrypt(password, salt, 64, version === passwordVersion ? passwordOptions : {})).toString('hex');
  }
  async function verifyPassword(password, user) {
    const validVersion = user && (user.passwordVersion === undefined || user.passwordVersion === passwordVersion);
    const candidate = await hashPassword(password, typeof user?.salt === 'string' ? user.salt : 'unavailable-user', validVersion ? user.passwordVersion ?? 1 : passwordVersion);
    return Boolean(validVersion && !user.disabled && equal(candidate, user.passwordHash));
  }
  async function credentials(data, register, kind, { address = 'trusted-maintenance' } = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.username !== 'string' || typeof data.password !== 'string') throw fail(400, '请提供账号和密码。');
    const username = data.username.trim().toLowerCase(), password = data.password;
    if (!/^[a-z0-9_.-]{3,64}$/.test(username) || password.length < 12 || password.length > 256) throw fail(400, '账号为 3–64 位字母、数字或 ._-，密码至少 12 位。');
    // Invalid invitations never allocate a password-hashing job. Transactional
    // consumption below still rechecks expiry, capacity and concurrent use.
    let release;
    try {
      if (register) { checkedInvite(store.read(), data.inviteCode, username); validateNewPassword(password, username); }
      credentialLimit(username, address);
      release = takeHashing(true);
      limited('credential-compute:global', 120);
      if (register) {
        const salt = crypto.randomBytes(16).toString('hex');
        const passwordHash = await hashPassword(password, salt);
        const result = await store.change(state => {
          const invite = consumeInvite(state, data.inviteCode, username);
          const user = { id: crypto.randomUUID(), username, salt, passwordHash, passwordVersion, createdAt: now(), role: 'user', allowance: invite.allowance || 0 };
          state.users.push(user); audit(state, user.id, 'account.register', invite.id);
          return { user: userView(user), ...session(state, user.id, kind) };
        });
        event('auth.register', address, username, 'success'); return result;
      }
      const user = store.read().users.find(item => item.username === username);
      if (!await verifyPassword(password, user)) throw fail(401, '账号或密码不正确。');
      const upgrade = user.passwordVersion === undefined ? { salt: crypto.randomBytes(16).toString('hex'), passwordVersion } : null;
      if (upgrade) upgrade.passwordHash = await hashPassword(password, upgrade.salt);
      const result = await store.change(state => {
        const current = state.users.find(item => item.id === user.id && !item.disabled);
        if (!current || !equal(current.passwordHash, user.passwordHash)) throw fail(401, '账号状态已变化。');
        if (kind === 'admin' && current.role !== 'admin') throw fail(403, '此账号没有管理员权限。');
        const pendingFactor = kind === 'admin' && current.mfa?.secret && !data.otp && !data.recoveryCode;
        if (current.mfa?.secret && !pendingFactor) {
          if (typeof data.otp === 'string' && /^\d{6}$/.test(data.otp) && !data.recoveryCode) limited(`mfa-login:${current.id}`, 5);
          mfa.factor(current, data);
        }
        if (upgrade) Object.assign(current, upgrade);
        audit(state, current.id, 'account.login', kind);
        return { user: userView(current), ...session(state, current.id, kind, { restricted: Boolean(pendingFactor || (current.role === 'admin' && !current.mfa?.secret)), mfaVerified: Boolean(current.mfa?.secret && !pendingFactor) }) };
      });
      event('auth.login', address, username, 'success'); return result;
    } catch (error) { event(register ? 'auth.register' : 'auth.login', address, username, error.status === 429 ? 'limited' : 'failure'); throw error; }
    finally { release?.(); }
  }
  async function secureAccount(request, response, entry, changePassword) {
    const data = await body(request);
    if (typeof data.currentPassword !== 'string' || data.currentPassword.length < 12 || data.currentPassword.length > 256) throw fail(400, '请填写当前密码。');
    if (changePassword && (typeof data.newPassword !== 'string' || data.newPassword.length < 12 || data.newPassword.length > 256)) throw fail(400, '新密码须为 12–256 位。');
    if (changePassword && equal(data.currentPassword, data.newPassword)) throw fail(400, '新密码不能与当前密码相同。');
    if (changePassword) validateNewPassword(data.newPassword, entry.user.username);
    limited(`reauth:${entry.hash}`, 6);
    const release = takeHashing();
    let deviceIds;
    try {
      if (!await verifyPassword(data.currentPassword, entry.user)) throw fail(400, '当前密码不正确。');
      const replacement = changePassword ? { salt: crypto.randomBytes(16).toString('hex'), passwordVersion } : null;
      if (replacement) replacement.passwordHash = await hashPassword(data.newPassword, replacement.salt);
      deviceIds = await store.change(state => {
        const current = requireCurrent(state, entry);
        if (!equal(current.passwordHash, entry.user.passwordHash)) throw fail(401, '账号状态已变化，请重新登录。');
        if (current.mfa?.secret) mfa.factor(current, data);
        if (replacement) Object.assign(current, replacement);
        const ids = revokeState(state, entry.userId);
        audit(state, entry.userId, changePassword ? 'account.password.change' : 'account.sessions.revoke', entry.userId);
        return ids;
      });
    } catch (error) { event(changePassword ? 'account.password.change' : 'account.sessions.revoke', clientAddress(request), entry.user.username, error.status === 429 ? 'limited' : 'failure'); throw error; }
    finally { release(); }
    await revokeUser(entry.userId, deviceIds);
    cookie(response, 'web');
    event(changePassword ? 'account.password.change' : 'account.sessions.revoke', clientAddress(request), entry.user.username, 'success');
    return json(response, 200, { ok: true, signedOut: true });
  }
  function revokeState(state, userId) {
    const ids = state.devices.filter(item => item.userId === userId).map(item => item.id);
    state.sessions = state.sessions.filter(item => item.userId !== userId);
    state.grants = state.grants.filter(item => item.userId !== userId);
    state.devices = state.devices.filter(item => item.userId !== userId);
    state.mfaEnrollments = state.mfaEnrollments.filter(item => item.userId !== userId);
    return ids;
  }
  async function mfaMutation(request, response, entry, action) {
    const data = await body(request);
    limited(`mfa:${entry.hash}`, 6);
    const address = clientAddress(request);
    let release;
    try {
      if (!['confirm', 'verify'].includes(action)) {
        if (typeof data.currentPassword !== 'string' || data.currentPassword.length < 12 || data.currentPassword.length > 256) throw fail(400, '请填写当前密码。');
        release = takeHashing();
        if (!await verifyPassword(data.currentPassword, entry.user)) throw fail(400, '当前密码不正确。');
      }
      const result = await store.change(state => {
        const user = requireCurrent(state, entry);
        if (!['confirm', 'verify'].includes(action) && !equal(user.passwordHash, entry.user.passwordHash)) throw fail(401, '账号状态已变化，请重新登录。');
        if (action === 'verify') {
          if (entry.kind !== 'admin' || entry.mfaVerified || !user.mfa?.secret) throw fail(403, '当前会话不需要登录验证。');
          if (typeof data.otp === 'string' && /^\d{6}$/.test(data.otp) && !data.recoveryCode) limited(`mfa-login:${user.id}`, 5);
          mfa.factor(user, data);
          state.sessions = state.sessions.filter(item => item.hash !== entry.hash);
          audit(state, user.id, 'mfa.login.verify', entry.kind);
          return { ok: true, ...session(state, user.id, entry.kind, { mfaVerified: true }) };
        }
        state.mfaEnrollments = state.mfaEnrollments.filter(item => item.expiresAt > now());
        if (action === 'enroll') {
          if (user.mfa?.secret) mfa.factor(user, data);
          const setup = mfa.begin(user, entry.hash);
          state.mfaEnrollments = state.mfaEnrollments.filter(item => item.sessionHash !== entry.hash);
          if (state.mfaEnrollments.length >= 1000) throw fail(429, '绑定请求过多，请稍后重试。');
          state.mfaEnrollments.push(setup.pending);
          audit(state, user.id, 'mfa.enrollment.start', entry.kind);
          return { secret: setup.secret, otpauthUrl: setup.otpauthUrl, expiresAt: setup.pending.expiresAt };
        }
        if (action === 'confirm') {
          const pending = state.mfaEnrollments.find(item => item.sessionHash === entry.hash && item.userId === user.id);
          const recoveryCodes = mfa.confirm(user, pending, data.otp);
          const deviceIds = revokeState(state, user.id);
          const loggedIn = session(state, user.id, entry.kind, { mfaVerified: true });
          audit(state, user.id, 'mfa.enable', entry.kind);
          return { ok: true, recoveryCodes, deviceIds, ...loggedIn };
        }
        if (action === 'disable' && user.role === 'admin') throw fail(403, '管理员必须保持验证器保护。', 'mfa_required');
        mfa.factor(user, data);
        const deviceIds = revokeState(state, user.id);
        if (action === 'disable') {
          delete user.mfa; audit(state, user.id, 'mfa.disable', entry.kind);
          return { ok: true, signedOut: true, deviceIds };
        }
        const recovery = mfa.recoveries(user.id);
        user.mfa.recoveryHashes = recovery.hashes; user.mfa.recoveryCreatedAt = now();
        audit(state, user.id, 'mfa.recovery.rotate', entry.kind);
        return { ok: true, recoveryCodes: recovery.codes, deviceIds, ...session(state, user.id, entry.kind, { mfaVerified: true }) };
      });
      if (result.deviceIds) await revokeUser(entry.userId, result.deviceIds);
      if (result.accessToken) cookie(response, entry.kind, result.accessToken, result.expiresAt);
      if (result.signedOut) cookie(response, entry.kind);
      const { accessToken, deviceIds, ...view } = result;
      event(`mfa.${action}`, address, entry.user.username, 'success');
      return json(response, 200, view);
    } catch (error) { event(`mfa.${action}`, address, entry.user.username, error.status === 429 ? 'limited' : 'failure'); throw error; }
    finally { release?.(); }
  }
  function quota(state, userId) {
    const user = state.users.find(item => item.id === userId);
    const used = state.usage.filter(item => item.userId === userId).reduce((sum, item) => sum + item.units, 0);
    return { total: user.allowance || 0, used, remaining: Math.max(0, (user.allowance || 0) - used), unit: '点', modelServiceEnabled: Boolean(modelService?.snapshot().policy.executionEnabled) };
  }
  function deviceList(userId) {
    return store.read().devices.filter(item => item.userId === userId).map(item => ({ id: item.id, name: item.name, online: online(item.id), desktopIdentity: item.desktopIdentity }));
  }
  async function handle(request, response, url) {
    const route = url.pathname, method = request.method;
    if (route === '/relay/auth/start' && method === 'POST') {
      limited(`device-start:${clientAddress(request)}`, 12);
      const data = await body(request);
      if (typeof data.challenge !== 'string' || !/^[\w-]{43}$/.test(data.challenge) || (data.name !== undefined && typeof data.name !== 'string')) throw fail(400, 'Invalid authorization challenge.');
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
      limited(`device-poll:${clientAddress(request)}`, 60);
      const data = await body(request);
      if (typeof data.deviceCode !== 'string' || !/^[\w-]{43}$/.test(data.deviceCode) || typeof data.verifier !== 'string' || !/^[\w-]{43,128}$/.test(data.verifier)) return json(response, 400, { error: 'invalid_grant' });
      const result = await store.change(state => {
        const entry = state.grants.find(item => equal(item.hash, digest(data.deviceCode)));
        if (!entry || entry.expiresAt <= now()) return { status: 400, error: 'expired_token' };
        if (!equal(crypto.createHash('sha256').update(data.verifier).digest('base64url'), entry.challenge)) return { status: 400, error: 'invalid_grant' };
        if (entry.nextPollAt > now()) { entry.interval = Math.min(entry.interval + 5000, 60000); entry.nextPollAt = now() + entry.interval; return { status: 400, error: 'slow_down', interval: entry.interval }; }
        entry.nextPollAt = now() + entry.interval;
        if (entry.status === 'pending') return { status: 400, error: 'authorization_pending' };
        state.grants = state.grants.filter(item => item !== entry);
        const user = state.users.find(item => item.id === entry.userId && !item.disabled);
        if (entry.status !== 'approved' || !user || ((user.mfa?.secret || user.role === 'admin') && !entry.mfaVerified)) return { status: 400, error: 'access_denied' };
        audit(state, user.id, 'desktop.login', entry.name);
        return { status: 200, username: user.username, ...session(state, user.id, 'account', { mfaVerified: Boolean(entry.mfaVerified) }) };
      });
      const { status, ...value } = result; return json(response, status, value);
    }
    if (!route.startsWith('/api/')) return false;
    const kind = route.startsWith('/api/admin/') ? 'admin' : 'web';
    const prefix = kind === 'admin' ? '/api/admin' : '/api/account';
    if (method === 'POST' && [`${prefix}/login`, `${prefix}/register`].includes(route)) {
      mutation(request); limited(`web-auth:${clientAddress(request)}`, 12);
      if (kind === 'admin' && route.endsWith('/register')) throw fail(404, '管理后台不开放注册。');
      const result = await credentials(await body(request), route.endsWith('/register'), kind, { address: clientAddress(request) });
      cookie(response, kind, result.accessToken, result.expiresAt);
      return json(response, route.endsWith('/register') ? 201 : 200, { user: result.user, expiresAt: result.expiresAt, mfa: result.mfa });
    }
    const entry = principal(request, kind);
    if (method !== 'GET') { mutation(request, entry); limited(`mutation:${entry.hash}`, 40); }
    if (isAccountSecurityRoute(method, route)) admitSecurity(request, response, entry);
    admitOwner(request, response, entry.userId);
    if (kind === 'admin' && now() - (entry.lastSeenAt || 0) >= 60000) await store.change(state => { requireCurrent(state, entry); const current = state.sessions.find(item => item.hash === entry.hash); current.lastSeenAt = now(); });
    if ((method === 'DELETE' || (method === 'POST' && route === `${prefix}/logout`)) && (request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) > 0)) {
      const empty = await body(request, 256);
      if (Object.keys(empty).length) throw fail(400, '此操作不接受额外请求内容。');
    }
    if (route === `${prefix}/session` && method === 'GET') return json(response, 200, { user: userView(entry.user), csrf: csrf(entry), expiresAt: entry.expiresAt, mfa: mfaState(entry.user, entry) });
    if (route === `${prefix}/mfa/status` && method === 'GET') return json(response, 200, mfaState(entry.user, entry));
    const mfaAction = kind === 'admin' && route === `${prefix}/mfa/verify` ? 'verify' : route === `${prefix}/mfa/enroll` ? 'enroll' : route === `${prefix}/mfa/confirm` ? 'confirm' : route === `${prefix}/mfa/recovery/rotate` ? 'rotate' : route === `${prefix}/mfa/disable` ? 'disable' : null;
    if (method === 'POST' && mfaAction) return mfaMutation(request, response, entry, mfaAction);
    if (route === `${prefix}/logout` && method === 'POST') {
      await store.change(state => { requireCurrent(state, entry); state.sessions = state.sessions.filter(item => item.hash !== entry.hash); state.mfaEnrollments = state.mfaEnrollments.filter(item => item.sessionHash !== entry.hash); });
      cookie(response, kind); return json(response, 200, { ok: true });
    }
    if (mfaState(entry.user, entry).restricted) throw fail(403, '请先完成验证器绑定并重新登录。', 'mfa_enrollment_required');
    if (modelService && kind === 'admin' && await modelService.handleAdmin(request, response, url, entry, { body, json })) return;
    if (modelService && kind === 'web' && await modelService.handleUser(request, response, url, entry, { body, json })) return;
    if (kind === 'web') {
      if (route === '/api/account/password' && method === 'POST') return secureAccount(request, response, entry, true);
      if (route === '/api/account/sessions/revoke' && method === 'POST') return secureAccount(request, response, entry, false);
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
          const current = requireCurrent(state, entry);
          if (mfaState(current, entry).restricted) throw fail(403, '请先完成验证器绑定。', 'mfa_enrollment_required');
          const grant = state.grants.find(item => item.userCode === data.code && item.expiresAt > now() && item.status === 'pending');
          if (!grant) throw fail(410, '登录请求已过期或已处理。');
          grant.status = data.approve ? 'approved' : 'denied'; grant.userId = entry.userId; grant.mfaVerified = Boolean(entry.mfaVerified);
        });
        return json(response, 200, { ok: true });
      }
    } else {
      if (route === '/api/admin/security' && method === 'GET') return json(response, 200, securityStatus());
      if (route === '/api/admin/invitations' && method === 'GET') return json(response, 200, { invitations: store.read().invitations.map(({ hash, ...item }) => item) });
      if (route === '/api/admin/invitations' && method === 'POST') {
        const data = await body(request), limit = Number(data.limit), days = Number(data.days);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(days) || days < 1 || days > 90) throw fail(400, '名额为 1–100 人，有效期为 1–90 天。');
        const code = `TRYLO-${crypto.randomBytes(18).toString('base64url')}`;
        const item = await store.change(state => {
          requireCurrent(state, entry);
          if (state.invitations.length >= 10000) throw fail(429, '邀请记录容量已达上限。');
          const record = { id: crypto.randomUUID(), hash: digest(code), suffix: code.slice(-6), note: String(data.note || '').slice(0, 120), limit, used: 0, createdAt: now(), expiresAt: now() + days * day, issuer: entry.userId, allowance: 0 };
          state.invitations.push(record); audit(state, entry.userId, 'invite.create', record.id);
          const { hash, ...view } = record; return view;
        });
        return json(response, 201, { invitation: item, code });
      }
      const revocation = route.match(/^\/api\/admin\/invitations\/([a-f0-9-]+)$/);
      if (revocation && method === 'DELETE') {
        await store.change(state => { requireCurrent(state, entry); const item = state.invitations.find(item => item.id === revocation[1]); if (!item) throw fail(404, '邀请不存在。'); item.revokedAt = now(); audit(state, entry.userId, 'invite.revoke', item.id); });
        return json(response, 200, { ok: true });
      }
      if (route === '/api/admin/users' && method === 'GET') { const state = store.read(); return json(response, 200, { users: state.users.map(user => ({ ...userView(user), quota: quota(state, user.id), devices: state.devices.filter(item => item.userId === user.id).length })) }); }
      if (route === '/api/admin/limits' && method === 'GET') return json(response, 200, { ...store.read().limits, modelServiceEnabled: Boolean(modelService?.snapshot().policy.executionEnabled) });
      if (route === '/api/admin/limits' && method === 'POST') {
        const data = await body(request);
        if (typeof data.registrationOpen !== 'boolean' || !Number.isInteger(data.maxAccounts) || data.maxAccounts < 1 || data.maxAccounts > 1000 || !Number.isInteger(data.maxDevices) || data.maxDevices < 1 || data.maxDevices > 50) throw fail(400, '账号上限 1–1000，单账号设备上限 1–50。');
        await store.change(state => { requireCurrent(state, entry); state.limits = { registrationOpen: data.registrationOpen, maxAccounts: data.maxAccounts, maxDevices: data.maxDevices }; audit(state, entry.userId, 'limits.update', 'platform'); });
        return json(response, 200, { ok: true });
      }
      if (route === '/api/admin/audit' && method === 'GET') return json(response, 200, { records: store.read().audit.slice(-200).reverse().map(item => ({ ...item, actor: store.read().users.find(user => user.id === item.actor)?.username || item.actor })) });
    }
    throw fail(404, '接口不存在。');
  }
  return { handle, credentials, consumeInvite };
}

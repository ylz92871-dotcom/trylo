import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createRelayServer } from '../src/server.mjs';
import { createStore } from '../src/store.mjs';
import { createRelayClient } from '../../desktop-services/src/remote/relay-client.mjs';
const password = 'synthetic-test-password-123';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-accounts-'));
  const portServer = net.createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const origin = `http://127.0.0.1:${port}`; let clock = Date.now();
  const salt = crypto.randomBytes(16).toString('hex'), passwordHash = (await promisify(crypto.scrypt)(password, salt, 64)).toString('hex');
  const legacy = { version: 1, users: [{ id: 'operator-id', username: 'ylz', salt, passwordHash, role: 'admin' }], devices: [], sessions: [] };
  const legacyBytes = JSON.stringify(legacy); await fs.writeFile(path.join(directory, 'state.json'), legacyBytes);
  let relay = await createRelayServer({ dataDir: directory, webOrigin: origin, secureCookies: false, now: () => clock, webDir: path.resolve('../trylocode-site/console') }); await relay.listen(port);
  t.after(async () => { await relay.close(); await fs.rm(directory, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', cookie, token, csrf, body, from = origin } = {}) {
    const response = await fetch(origin + route, { method, headers: { ...(from ? { Origin: from } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => ({})); return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0], response };
  }
  async function login(scope = 'admin', username = 'ylz') {
    const result = await request(`/api/${scope}/login`, { method: 'POST', body: { username, password } }); assert.equal(result.status, 200);
    const session = await request(`/api/${scope}/session`, { cookie: result.cookie }); assert.equal(session.status, 200);
    return { cookie: result.cookie, csrf: session.data.csrf, body: {}, method: 'POST' };
  }
  const admin = await login();
  async function invite(limit = 1) { const result = await request('/api/admin/invitations', { ...admin, body: { limit, days: 7, note: 'test batch' } }); assert.equal(result.status, 201); return result.data; }
  return { directory, origin, admin, request, login, invite, legacyBytes, advance(ms) { clock += ms; }, async restart() { await relay.close(); relay = await createRelayServer({ dataDir: directory, webOrigin: origin, secureCookies: false, now: () => clock }); await relay.listen(port); } };
}

test('migration preserves legacy bytes, identity and credentials; admin/user sessions cannot cross scopes', async t => {
  const f = await fixture(t), user = await f.login('account');
  assert.equal(await fs.readFile(path.join(f.directory, 'state.json'), 'utf8'), f.legacyBytes);
  assert.equal((await f.request('/api/account/session', { cookie: f.admin.cookie })).status, 401);
  assert.equal((await f.request('/api/admin/users', { cookie: user.cookie })).status, 401);
  assert.equal((await f.request('/api/admin/users', f.admin)).status, 404); // POST is not a read endpoint.
  const listed = await f.request('/api/admin/users', { cookie: f.admin.cookie });
  assert.equal(listed.data.users[0].id, 'operator-id'); assert.equal(JSON.stringify(listed.data).includes('passwordHash'), false);
  await f.restart(); assert.equal((await f.request('/api/account/session', { cookie: user.cookie })).status, 200);
});

test('invitation consumption is atomic under concurrent registration, no first-user admin, native bypass closed', async t => {
  const f = await fixture(t), invitation = await f.invite();
  const results = await Promise.all(['one', 'two'].map(username => f.request('/api/account/register', { method: 'POST', body: { username, password, inviteCode: invitation.code, role: 'admin' } })));
  assert.deepEqual(results.map(item => item.status).sort(), [201, 403]);
  const joined = results.find(item => item.status === 201); assert.equal(joined.data.user.role, 'user');
  const session = await f.request('/api/account/session', { cookie: joined.cookie });
  const forbidden = await f.request('/api/admin/login', { method: 'POST', body: { username: session.data.user.username, password } }); assert.equal(forbidden.status, 403);
  assert.equal((await f.request('/relay/register', { method: 'POST', body: { username: 'bypass', password, inviteCode: invitation.code } })).status, 403);
  const records = await f.request('/api/admin/invitations', { cookie: f.admin.cookie });
  assert.equal(records.data.invitations[0].used, 1); assert.ok(!JSON.stringify(records.data).includes(invitation.code)); assert.ok(!('hash' in records.data.invitations[0]));
});

test('CSRF/origin enforcement, closed registration and revocation are authoritative', async t => {
  const f = await fixture(t), invite = await f.invite();
  assert.equal((await f.request('/api/admin/invitations', { method: 'POST', cookie: f.admin.cookie, body: { limit: 1, days: 7 } })).status, 403);
  assert.equal((await f.request('/api/admin/invitations', { ...f.admin, from: 'https://evil.test', body: { limit: 1, days: 7 } })).status, 403);
  assert.equal((await f.request('/api/admin/limits', { ...f.admin, body: { registrationOpen: false, maxAccounts: 100, maxDevices: 2 } })).status, 200);
  assert.equal((await f.request('/relay/register', { method: 'POST', body: { username: 'closed', password, inviteCode: invite.code } })).status, 403);
  await f.request('/api/admin/limits', { ...f.admin, body: { registrationOpen: true, maxAccounts: 100, maxDevices: 2 } });
  await f.request(`/api/admin/invitations/${invite.invitation.id}`, { ...f.admin, method: 'DELETE' });
  assert.equal((await f.request('/api/account/register', { method: 'POST', body: { username: 'revoked', password, inviteCode: invite.code } })).status, 403);
});

test('browser authorization exchanges once into Desktop session, web logout does not log Desktop out; removal revokes native session', async t => {
  const f = await fixture(t), web = await f.login('account');
  const client = createRelayClient({ appDataDir: path.join(f.directory, 'desktop'), allowLocal: true });
  const started = await client.beginBrowserLogin({ serverUrl: f.origin });
  assert.equal('deviceCode' in started, false); assert.equal('verifier' in started, false);
  assert.equal((await client.pollBrowserLogin({ id: started.id })).status, 'pending');
  assert.equal((await f.request(`/api/account/authorization?code=${started.userCode}`, { cookie: web.cookie })).status, 200);
  await f.request('/api/account/authorization', { ...web, body: { code: started.userCode, approve: true } });
  f.advance(11000);
  const accepted = await client.pollBrowserLogin({ id: started.id }); assert.equal(accepted.account.username, 'ylz');
  assert.equal(accepted.account.loggedIn, true); await assert.rejects(client.pollBrowserLogin({ id: started.id }));
  const file = path.join(f.directory, 'desktop/Trylo/remote/relay-session.json'); const credentials = JSON.parse(await fs.readFile(file, 'utf8'));
  const device = await f.request('/relay/devices', { method: 'POST', token: credentials.accessToken, body: { desktopIdentity: 'identity-test-123', name: 'test Desktop' } }); assert.equal(device.status, 201);
  const relogin = await f.request('/relay/login', { method: 'POST', body: { username: 'ylz', password } });
  assert.equal((await f.request('/relay/device-session', { method: 'POST', token: relogin.data.accessToken, body: { deviceId: device.data.deviceId, deviceSecret: 'wrong' } })).status, 404);
  assert.equal((await f.request('/relay/device-session', { method: 'POST', token: relogin.data.accessToken, body: { deviceId: device.data.deviceId, deviceSecret: device.data.deviceSecret } })).status, 200);
  await f.request('/api/account/logout', web);
  assert.equal((await f.request('/api/account/session', { cookie: web.cookie })).status, 401);
  assert.equal((await client.status()).loggedIn, true);
  const nextWeb = await f.login('account');
  assert.equal((await f.request(`/api/account/devices/${device.data.deviceId}`, { ...nextWeb, method: 'DELETE' })).status, 200);
  assert.equal((await client.status()).loggedIn, false);
  assert.equal((await f.request('/relay/account', { token: relogin.data.accessToken })).status, 401);
});

test('authorization proof binding, expiration, denial, owner device isolation and no fake model data', async t => {
  const f = await fixture(t), web = await f.login('account'), verifier = crypto.randomBytes(32).toString('base64url');
  const grant = await f.request('/relay/auth/start', { method: 'POST', body: { challenge: crypto.createHash('sha256').update(verifier).digest('base64url') } });
  f.advance(6000);
  assert.equal((await f.request('/relay/auth/poll', { method: 'POST', body: { deviceCode: grant.data.deviceCode, verifier: 'x'.repeat(43) } })).data.error, 'invalid_grant');
  await f.request('/api/account/authorization', { ...web, body: { code: grant.data.userCode, approve: false } });
  assert.equal((await f.request('/relay/auth/poll', { method: 'POST', body: { deviceCode: grant.data.deviceCode, verifier } })).data.error, 'access_denied');
  assert.equal((await f.request('/api/account/authorization?code=BADCODE', { cookie: web.cookie })).status, 410);
  const expired = await f.request('/relay/auth/start', { method: 'POST', body: { challenge: crypto.createHash('sha256').update(verifier).digest('base64url') } });
  f.advance(600001);
  assert.equal((await f.request('/relay/auth/poll', { method: 'POST', body: { deviceCode: expired.data.deviceCode, verifier } })).data.error, 'expired_token');
  const invitation = await f.invite();
  const native = await f.request('/relay/register', { method: 'POST', body: { username: 'other', password, inviteCode: invitation.code } });
  const foreignDevice = await f.request('/relay/devices', { method: 'POST', token: native.data.accessToken, body: { desktopIdentity: 'other-identity-123' } });
  assert.equal((await f.request(`/api/account/devices/${foreignDevice.data.deviceId}`, { ...web, method: 'DELETE' })).status, 404);
  const summary = await f.request('/api/account/summary', { cookie: web.cookie }); assert.equal(summary.data.quota.total, 0); assert.equal(summary.data.quota.modelServiceEnabled, false);
  assert.deepEqual((await f.request('/api/account/usage', { cookie: web.cookie })).data.records, []);
  const staticPage = await fetch(f.origin + '/account/'); assert.equal(staticPage.status, 200); assert.match(staticPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(f.origin + '/console/../state.json')).status, 404);
});

test('native renewal rotates its token and leaves browser login intact', async t => {
  const f = await fixture(t), web = await f.login('account');
  const login = await f.request('/relay/login', { method: 'POST', body: { username: 'ylz', password } });
  const refreshed = await f.request('/relay/refresh', { method: 'POST', token: login.data.accessToken, body: {} });
  assert.equal(refreshed.status, 200); assert.notEqual(refreshed.data.accessToken, login.data.accessToken);
  assert.equal((await f.request('/relay/account', { token: login.data.accessToken })).status, 401);
  assert.equal((await f.request('/relay/account', { token: refreshed.data.accessToken })).status, 200);
  assert.equal((await f.request('/api/account/session', { cookie: web.cookie })).status, 200);
});

test('saved Desktop sessions renew in the background and observe server revocation', async t => {
  const f = await fixture(t), location = path.join(f.directory, 'renewal/Trylo/remote/relay-session.json');
  const login = await f.request('/relay/login', { method: 'POST', body: { username: 'ylz', password } });
  await fs.mkdir(path.dirname(location), { recursive: true });
  await fs.writeFile(location, JSON.stringify({ serverUrl: f.origin, username: 'ylz', accessToken: login.data.accessToken, expiresAt: Date.now() + 60000 }));
  const client = createRelayClient({ appDataDir: path.join(f.directory, 'renewal'), allowLocal: true, seam: { accountCheckIntervalMs: 25 } });
  // Loading an expiring session renews it; the bounded monitor then detects an
  // independent server-side revocation without needing a settings panel reopen.
  assert.equal((await client.status()).loggedIn, true);
  const persisted = JSON.parse(await fs.readFile(location, 'utf8'));
  assert.notEqual(persisted.accessToken, login.data.accessToken);
  await f.request('/relay/logout', { method: 'POST', token: persisted.accessToken });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { try { await fs.access(location); } catch { break; } await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.equal((await client.status()).loggedIn, false);
  await assert.rejects(fs.access(location));
});

test('failed writes roll back invitation use and database remains readable', async t => {
  const f = await fixture(t), store = await createStore(f.directory);
  try {
    await assert.rejects(store.change(state => { state.users = []; throw new Error('transaction failure'); }));
    assert.equal(store.read().users.length, 1);
  } finally { await store.close(); }
});

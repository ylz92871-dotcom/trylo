import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.mjs';
import { createModelQuota, quotaWindow } from '../src/model-service/quota.mjs';
import { createModelService } from '../src/model-service/service.mjs';
import { createRelayServer } from '../src/server.mjs';

const testRoot = path.resolve(fileURLToPath(new URL('../evidence/model-quota-20261023/test-data', import.meta.url)));
const instant = Date.parse('2026-10-23T12:00:00Z');
const fingerprint = crypto.createHash('sha256').update('synthetic request').digest('hex');
async function fixture(t, options = {}) {
  await fs.mkdir(testRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testRoot, 'case-'));
  const store = await createStore(directory); let clock = instant;
  await store.change(state => { state.users = [{ id: 'admin', username: 'operator', role: 'admin' }, { id: 'one', username: 'tester.one' }, { id: 'two', username: 'tester.two' }]; });
  let service;
  t.after(async () => {
    if (service) await service.close(); await store.close();
    if (!path.resolve(directory).startsWith(testRoot + path.sep)) throw Error('Refusing cleanup outside test root');
    await fs.rm(directory, { recursive: true, force: true });
  });
  const quota = await createModelQuota({ store, now: () => clock, ...options });
  const source = { name: 'Synthetic API', type: 'free', endpoint: 'https://example.invalid/v1', protocol: 'chat', models: ['test-model'], unit: 'tokens', period: 'day', defaultLimit: 100, totalLimit: 200, concurrency: 4, ...options.source };
  await quota.saveUpstream(source, 'admin'); const id = quota.snapshot().upstreams[0].id; await quota.setEnabled(id, true, 'admin');
  async function grant(userId = 'one', extra = {}) {
    await quota.saveGrant({ userId, upstreamId: id, models: ['test-model'], limit: 100, expiresAt: '2026-11-23', ...extra }, 'admin');
    return quota.snapshot().grants.find(item => item.userId === userId && !item.revoked);
  }
  await grant();
  const reserve = (extra = {}) => quota.reserve({ userId: 'one', upstreamId: id, model: 'test-model', requestKey: crypto.randomUUID(), fingerprint, units: 50, ...extra });
  return { store, quota, directory, source, id, grant, reserve, advance(ms) { clock += ms; }, now: () => clock,
    async execution(executor, timeout = 1000) { service = await createModelService({ store, now: () => clock, executor, requestTimeoutMs: timeout }); return service; } };
}
const quotaOf = f => f.quota.userQuotas('one').quotas.find(item => !item.revoked);

test('two SQLite connections atomically preoccupy remaining quota; agents share the same account', async t => {
  const f = await fixture(t, { userConcurrency: 100 }), secondStore = await createStore(f.directory);
  try {
    const second = await createModelQuota({ store: secondStore, now: f.now, userConcurrency: 100 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => (index % 2 ? second : f.quota).reserve({ userId: 'one', upstreamId: f.id, model: 'test-model', requestKey: crypto.randomUUID(), fingerprint, units: 40 })));
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 2);
    assert.equal(quotaOf(f).reserved, 80); assert.equal(quotaOf(f).remaining, 20);
  } finally { await secondStore.close(); }
});

test('account concurrency covers multiple upstreams and model names', async t => {
  const f = await fixture(t, { userConcurrency: 1 });
  await f.reserve({ units: 1 });
  await f.quota.saveUpstream({ ...f.source, name: 'Second source' }, 'admin');
  const source = f.quota.snapshot().upstreams[1]; await f.quota.setEnabled(source.id, true, 'admin');
  await f.quota.saveGrant({ userId: 'one', upstreamId: source.id, models: ['test-model'], limit: 100, expiresAt: '2026-11-23' }, 'admin');
  await assert.rejects(f.reserve({ upstreamId: source.id, units: 1 }), error => error.code === 'concurrency_exhausted');
});

test('upstream pool is enforced across separately entitled users', async t => {
  const f = await fixture(t, { source: { totalLimit: 100 } }); await f.grant('two');
  await f.reserve({ units: 70 });
  await assert.rejects(f.reserve({ userId: 'two', units: 40 }), error => error.code === 'quota_exhausted');
  assert.equal(f.quota.userQuotas('two').quotas[0].remaining, 100);
  assert.equal(f.quota.userQuotas('two').quotas[0].upstreamRemaining, 30);
});

test('settlement releases unused reservation once; conflicting duplicate settlement is rejected', async t => {
  const f = await fixture(t), request = await f.reserve(); await f.quota.dispatch(request.id);
  await f.quota.settle(request.id, 17); await f.quota.settle(request.id, 17);
  assert.equal(quotaOf(f).used, 17); assert.equal(quotaOf(f).reserved, 0); assert.equal(quotaOf(f).remaining, 83);
  await assert.rejects(f.quota.settle(request.id, 18), error => error.status === 409);
  assert.equal(quotaOf(f).used, 17);
});

test('request id replay never reserves or invokes twice, even after settlement', async t => {
  const f = await fixture(t); const requestKey = crypto.randomUUID();
  const request = await f.reserve({ requestKey });
  await assert.rejects(f.reserve({ requestKey }), error => error.code === 'request_already_recorded');
  await f.quota.dispatch(request.id); await f.quota.settle(request.id, 10);
  await assert.rejects(f.reserve({ requestKey, fingerprint: 'b'.repeat(64) }), error => error.status === 409);
  assert.equal(f.quota.requests('one').length, 1);
});

test('undispatched cancellation refunds; uncertain dispatched work remains charged', async t => {
  const f = await fixture(t), unsent = await f.reserve(); await f.quota.release(unsent.id);
  assert.equal(quotaOf(f).remaining, 100);
  const sent = await f.reserve(); await f.quota.dispatch(sent.id); await f.quota.uncertain(sent.id); await f.quota.release(sent.id);
  assert.equal(quotaOf(f).used, 50); assert.equal(quotaOf(f).reserved, 0); assert.equal(f.quota.requests('one')[0].status, 'uncertain');
});

test('recovery persists uncertain cost and releases only provably undispatched operations', async t => {
  const f = await fixture(t); const unsent = await f.reserve({ units: 20 }); const sent = await f.reserve({ units: 30 });
  await f.quota.dispatch(sent.id); await f.quota.recoverAfterRestart();
  const records = f.quota.requests('one');
  assert.equal(records.find(item => item.id === unsent.id).status, 'released');
  assert.equal(records.find(item => item.id === sent.id).status, 'uncertain'); assert.equal(quotaOf(f).remaining, 70);
  const nextStore = await createStore(f.directory);
  try { const next = await createModelQuota({ store: nextStore, now: f.now }); assert.equal(next.userQuotas('one').quotas[0].used, 30); }
  finally { await nextStore.close(); }
});

test('period rollover keeps late usage in its original accounting window', async t => {
  const f = await fixture(t), request = await f.reserve(); await f.quota.dispatch(request.id);
  f.advance(86400000); await f.quota.settle(request.id, 40);
  assert.equal(quotaOf(f).used, 0); assert.equal(quotaOf(f).remaining, 100);
  assert.equal(f.quota.requests('one')[0].used, 40);
});

test('grant identity and accounting metric stay immutable, including revoked history', async t => {
  const f = await fixture(t), grant = quotaOf(f);
  await assert.rejects(f.quota.saveGrant({ ...grant, userId: 'two' }, 'admin'), error => error.status === 409);
  await f.quota.revoke(grant.id, 'admin');
  await assert.rejects(f.quota.saveUpstream({ ...f.source, id: f.id, unit: 'requests' }, 'admin'), error => error.code === 'accounting_immutable');
});

test('lowered quota cannot reinterpret or erase used and preoccupied amounts', async t => {
  const f = await fixture(t), grant = quotaOf(f); await f.reserve({ units: 60 });
  await assert.rejects(f.quota.saveGrant({ ...grant, limit: 50 }, 'admin'), error => error.status === 409);
  await assert.rejects(f.quota.saveUpstream({ ...f.source, id: f.id, totalLimit: 50, defaultLimit: 50 }, 'admin'), error => error.status === 409);
  assert.equal(quotaOf(f).reserved, 60);
});

test('disabled user, paused source, expired/revoked grant and ungranted model block dispatch', async t => {
  const f = await fixture(t);
  await assert.rejects(f.reserve({ userId: 'two' }), error => error.status === 403);
  await assert.rejects(f.reserve({ model: 'ungranted' }), error => error.status === 403);
  const request = await f.reserve(); await f.quota.setEnabled(f.id, false, 'admin');
  await assert.rejects(f.quota.dispatch(request.id), error => error.status === 403); await f.quota.release(request.id);
  await f.quota.setEnabled(f.id, true, 'admin'); await f.quota.revoke(quotaOf(f).id, 'admin');
  await assert.rejects(f.reserve(), error => error.status === 403);
  await f.grant('two'); await f.store.change(state => { state.users.find(user => user.id === 'two').disabled = true; });
  await assert.rejects(f.reserve({ userId: 'two' }), error => error.code === 'account_unavailable');
  await f.store.change(state => { state.users.find(user => user.id === 'two').disabled = false; });
  f.advance(40 * 86400000);
  await assert.rejects(f.reserve({ userId: 'two' }), error => error.code === 'grant_unavailable');
});

test('administrator reconciliation requires evidence and keeps an audit marker', async t => {
  const f = await fixture(t), request = await f.reserve(); await f.quota.dispatch(request.id); await f.quota.uncertain(request.id);
  await assert.rejects(f.quota.settle(request.id, 8, { reconcile: true, actor: 'one', reason: 'verified upstream log' }), error => error.status === 400);
  await f.quota.settle(request.id, 8, { reconcile: true, actor: 'admin', reason: 'verified upstream usage record' });
  assert.equal(quotaOf(f).used, 8); assert.equal(f.quota.requests('one')[0].reconciledBy, 'admin');
});

test('an adapter that exceeds its reserved ceiling records actual debt and pauses the source', async t => {
  const f = await fixture(t), request = await f.reserve({ units: 10 }); await f.quota.dispatch(request.id); await f.quota.settle(request.id, 25);
  assert.equal(quotaOf(f).used, 25); assert.equal(f.quota.snapshot().upstreams[0].enabled, false);
});

test('Shanghai day/week/month and source-anchored five-hour windows are deterministic', () => {
  assert.equal(quotaWindow(Date.parse('2026-10-23T16:00:00Z'), 'day').start, Date.parse('2026-10-23T16:00:00Z'));
  assert.equal(quotaWindow(instant, 'week').start, Date.parse('2026-10-18T16:00:00Z'));
  assert.equal(quotaWindow(Date.parse('2028-02-29T12:00:00Z'), 'month').end, Date.parse('2028-02-29T16:00:00Z'));
  assert.deepEqual(quotaWindow(100 + 5 * 3600000, 'fiveHours', 100), { start: 100 + 5 * 3600000, end: 100 + 10 * 3600000 });
});

test('missing adapter cannot dispatch or consume quota', async t => {
  const f = await fixture(t), service = await f.execution(null);
  await assert.rejects(service.execute('one', { upstreamId: f.id }), error => error.status === 503);
  assert.equal(f.quota.requests().length, 0);
});

test('request metric bills exactly one; global concurrency is shared across users', async t => {
  const f = await fixture(t, { globalConcurrency: 1, source: { unit: 'requests' } }); await f.grant('two');
  await assert.rejects(f.reserve(), error => error.status === 400);
  const pending = await f.reserve({ units: 1 });
  await assert.rejects(f.reserve({ units: 1, userId: 'two' }), error => error.code === 'concurrency_exhausted');
  await f.quota.release(pending.id);
  const service = await f.execution({ run: async () => ({ value: { ok: true }, units: 9999 }) });
  await service.execute('one', { upstreamId: f.id, model: 'test-model', requestKey: crypto.randomUUID(), payload: {} });
  assert.equal(quotaOf(f).used, 1);
});

test('service close cancels active execution and keeps unknown usage across restart', async t => {
  const f = await fixture(t); let started;
  const running = new Promise(resolve => { started = resolve; });
  const service = await f.execution({ quote: () => 50, run() { started(); return new Promise(() => {}); } });
  const result = service.execute('one', { upstreamId: f.id, model: 'test-model', requestKey: crypto.randomUUID(), payload: {} });
  const rejected = assert.rejects(result, error => error.status === 504); await running; await service.close(); await rejected;
  assert.equal(quotaOf(f).used, 50); assert.equal(f.quota.requests('one')[0].status, 'uncertain');
  await assert.rejects(service.execute('one', {}), error => error.status === 503);
});

test('timeout holds worst-case cost; trusted late usage settles once without replay', async t => {
  const f = await fixture(t); let finish, count = 0;
  const service = await f.execution({ quote: () => 50, run() { count++; return new Promise(resolve => { finish = resolve; }); } }, 20);
  await assert.rejects(service.execute('one', { upstreamId: f.id, model: 'test-model', requestKey: crypto.randomUUID(), payload: {} }), error => error.status === 504);
  assert.equal(quotaOf(f).used, 50); assert.equal(count, 1);
  finish({ units: 7, value: { ok: true } });
  for (let attempt = 0; attempt < 50 && quotaOf(f).used !== 7; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(quotaOf(f).used, 7); assert.equal(count, 1);
});

test('unknown token usage is held, while cancellation before dispatch consumes nothing', async t => {
  const f = await fixture(t), service = await f.execution({ quote: () => 50, run: async () => ({ value: {} }) });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(service.execute('one', { upstreamId: f.id, model: 'test-model', requestKey: crypto.randomUUID(), payload: {} }, aborted.signal));
  assert.equal(quotaOf(f).remaining, 100);
  await assert.rejects(service.execute('one', { upstreamId: f.id, model: 'test-model', requestKey: crypto.randomUUID(), payload: {} }), error => error.status === 502);
  assert.equal(quotaOf(f).used, 50);
});

async function httpFixture(t) {
  await fs.mkdir(testRoot, { recursive: true }); const directory = await fs.mkdtemp(path.join(testRoot, 'http-'));
  const password = 'synthetic-quota-password-123', salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = (await promisify(crypto.scrypt)(password, salt, 64)).toString('hex');
  const store = await createStore(directory); await store.change(state => { state.users = [{ id: 'admin', username: 'operator', role: 'admin', salt, passwordHash }, { id: 'one', username: 'tester.one', salt, passwordHash }, { id: 'two', username: 'tester.two', salt, passwordHash }]; }); await store.close();
  let upstreamCalls = 0;
  const upstream = http.createServer((request, response) => { upstreamCalls++; request.resume(); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ value: { text: 'synthetic upstream reply' }, units: 7 })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const executor = { quote: () => 20, async run() { return fetch(`http://127.0.0.1:${upstream.address().port}/synthetic`, { method: 'POST' }).then(response => response.json()); } };
  // Port zero is supported by listen; determine the actual origin before login.
  const relay = await createRelayServer({ dataDir: directory, secureCookies: false, webOrigin: 'https://quota.test', modelExecutor: executor, webDir: path.resolve('../trylocode-site/console') }); await relay.listen(0);
  const origin = `http://127.0.0.1:${relay.server.address().port}`;
  t.after(async () => { await relay.close(); await new Promise(resolve => upstream.close(resolve)); if (!path.resolve(directory).startsWith(testRoot + path.sep)) throw Error('Invalid cleanup root'); await fs.rm(directory, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', cookie, csrf, token, body } = {}) {
    const response = await fetch(origin + route, { method, headers: { Origin: 'https://quota.test', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function login(scope, username) {
    const result = await request(`/api/${scope}/login`, { method: 'POST', body: { username, password } }); assert.equal(result.status, 200);
    const session = await request(`/api/${scope}/session`, { cookie: result.cookie }); return { cookie: result.cookie, csrf: session.data.csrf };
  }
  const admin = await login('admin', 'operator'), user = await login('account', 'tester.one'), other = await login('account', 'tester.two');
  return { request, admin, user, other, password, calls: () => upstreamCalls };
}

test('HTTP: existing auth/CSRF protect real policy, account isolation and metered upstream dispatch', async t => {
  const f = await httpFixture(t), path = '/api/admin/model-service';
  assert.equal((await f.request(path)).status, 401);
  assert.equal((await f.request(path, f.user)).status, 401);
  const source = { name: 'Loopback adapter fixture', type: 'plan', endpoint: 'https://example.invalid/v1', protocol: 'chat', models: ['test-model'], unit: 'tokens', period: 'day', defaultLimit: 30, totalLimit: 50, concurrency: 2 };
  assert.equal((await f.request(path + '/upstreams', { cookie: f.admin.cookie, method: 'POST', body: source })).status, 403);
  const created = await f.request(path + '/upstreams', { ...f.admin, method: 'POST', body: source }); assert.equal(created.status, 200);
  const id = created.data.upstreams[0].id;
  assert.equal((await f.request(`${path}/upstreams/${id}/enabled`, { ...f.admin, method: 'POST', body: null })).status, 400);
  assert.equal((await f.request(`${path}/requests/${id}/reconcile`, { ...f.admin, method: 'POST', body: [] })).status, 400);
  assert.equal((await f.request(path + '/upstreams', { ...f.admin, method: 'POST', body: { ...source, apiKey: 'synthetic-never-store' } })).status, 400);
  assert.equal((await f.request(`${path}/upstreams/${id}/enabled`, { ...f.admin, method: 'POST', body: { enabled: true } })).status, 200);
  assert.equal((await f.request(path + '/grants', { ...f.admin, method: 'POST', body: { userId: 'one', upstreamId: id, models: ['test-model'], limit: 30, expiresAt: '2030-01-01' } })).status, 200);
  assert.equal((await f.request('/api/account/model-quotas', f.other)).data.quotas.length, 0);
  const request = { upstreamId: id, model: 'test-model', requestKey: crypto.randomUUID(), payload: {} };
  assert.equal((await f.request('/api/account/model-requests', { ...f.user, method: 'POST', body: { ...request, units: 0 } })).status, 400);
  assert.equal(f.calls(), 0);
  const result = await f.request('/api/account/model-requests', { ...f.user, method: 'POST', body: request }); assert.equal(result.status, 200); assert.equal(result.data.result.text, 'synthetic upstream reply');
  assert.equal(f.calls(), 1); assert.equal((await f.request('/api/account/model-quotas', f.user)).data.quotas[0].used, 7);
  assert.equal((await f.request('/api/account/model-requests', { ...f.user, method: 'POST', body: request })).status, 409); assert.equal(f.calls(), 1);
  // One more request can reserve 20; the following cannot reserve another 20.
  assert.equal((await f.request('/api/account/model-requests', { ...f.user, method: 'POST', body: { ...request, requestKey: crypto.randomUUID() } })).status, 200);
  assert.equal((await f.request('/api/account/model-requests', { ...f.user, method: 'POST', body: { ...request, requestKey: crypto.randomUUID() } })).status, 429); assert.equal(f.calls(), 2);
  assert.equal((await f.request('/api/account/model-usage', f.other)).data.records.length, 0);
  assert.equal((await f.request('/api/account/model-service/settle', { ...f.user, method: 'POST', body: { units: 0 } })).status, 404);
  const native = await f.request('/relay/login', { method: 'POST', body: { username: 'tester.one', password: f.password } }); assert.equal(native.status, 200);
  const nativeQuota = await f.request('/relay/model-quotas', { token: native.data.accessToken }); assert.equal(nativeQuota.status, 200); assert.equal(nativeQuota.data.quotas[0].used, 14);
  const snapshot = await f.request(path, f.admin); assert.equal(snapshot.data.grants[0].used, 14);
  const audit = await f.request('/api/admin/audit', f.admin);
  assert.ok(audit.data.records.some(item => item.action === 'model.grant.create' && item.actor === 'operator'));
  for (const asset of ['index.js', 'api-client.js', 'style.css']) {
    const response = await f.request(`/console/admin/model-service/${asset}`); assert.equal(response.status, 200);
  }
  assert.equal((await f.request('/console/admin/model-service/README.md')).status, 404);
});

test('only authenticated model routes accept a large bounded request', async t => {
  const f = await httpFixture(t), adminPath = '/api/admin/model-service';
  const source = { name: 'Loopback bound fixture', type: 'plan', endpoint: 'https://example.invalid/v1', protocol: 'chat', models: ['test-model'], unit: 'tokens', period: 'day', defaultLimit: 1000, totalLimit: 1000, concurrency: 2 };
  const created = await f.request(adminPath + '/upstreams', { ...f.admin, method: 'POST', body: source }); assert.equal(created.status, 200);
  const id = created.data.upstreams[0].id;
  assert.equal((await f.request(`${adminPath}/upstreams/${id}/enabled`, { ...f.admin, method: 'POST', body: { enabled: true } })).status, 200);
  assert.equal((await f.request(adminPath + '/grants', { ...f.admin, method: 'POST', body: { userId: 'one', upstreamId: id, models: ['test-model'], limit: 1000, expiresAt: '2030-01-01' } })).status, 200);
  const body = characters => ({upstreamId: id, model:'test-model', requestKey:crypto.randomUUID(), payload:{messages:[{role:'user',content:'x'.repeat(characters)}]}});
  assert.equal((await f.request('/api/account/model-requests', {...f.user,method:'POST',body:body(600000)})).status,200);
  const native = await f.request('/relay/login',{method:'POST',body:{username:'tester.one',password:f.password}}); assert.equal(native.status,200);
  assert.equal((await f.request('/relay/model-requests',{token:native.data.accessToken,method:'POST',body:body(600000)})).status,200);
  const before = f.calls();
  assert.equal((await f.request('/api/account/model-requests',{...f.user,method:'POST',body:body(8400000)})).status,413);
  assert.equal((await f.request('/relay/model-requests',{token:native.data.accessToken,method:'POST',body:body(8400000)})).status,413);
  assert.equal(f.calls(),before);
  assert.equal((await f.request('/api/admin/limits',{...f.admin,method:'POST',body:{padding:'x'.repeat(600000)}})).status,413);
  assert.equal((await f.request('/relay/device-session',{token:native.data.accessToken,method:'POST',body:{padding:'x'.repeat(600000)}})).status,413);
});


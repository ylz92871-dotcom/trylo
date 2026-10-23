import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRelayClient } from '../../src/remote/relay-client.mjs';

// Lifecycle/opener seam tests; real authorization/proof exchange is in remote-relay/accounts.test.mjs.
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, { delayedStart = false, delayedPoll = false, failOpen = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-avatar-auth-'));
  const startEntered = deferred(), releaseStart = deferred(), pollEntered = deferred(), releasePoll = deferred();
  const opened = [], revocations = [];
  let origin;
  const server = http.createServer(async (request, response) => {
    request.resume();
    let value = {};
    if (request.url === '/relay/auth/start') {
      startEntered.resolve(); if (delayedStart) await releaseStart.promise;
      value = { verificationUrl: origin + '/account/#authorize?code=ABCDEF123456', deviceCode: 'private-device-proof', userCode: 'ABCDEF123456', interval: 5000, expiresAt: Date.now() + 600000 };
    } else if (request.url === '/relay/auth/poll') {
      pollEntered.resolve(); if (delayedPoll) await releasePoll.promise;
      value = { username: 'ylz', accessToken: 'synthetic-access-token-long-enough-for-validation', expiresAt: Date.now() + 86400000 };
    } else if (request.url === '/relay/account') value = { username: 'ylz' };
    else if (request.url === '/relay/refresh') value = { accessToken: 'renewed-synthetic-access-token-for-fixture-only', expiresAt: Date.now() + 172800000 };
    else if (request.url === '/relay/logout') { revocations.push(request.headers.authorization); value = { ok: true }; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  const client = createRelayClient({ appDataDir: directory, allowLocal: true, seam: { openBrowser: async url => { if (failOpen) throw new Error('fixture opener failed'); opened.push(url); } } });
  t.after(async () => {
    releaseStart.resolve(); releasePoll.resolve(); await client.disable();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, origin, client, opened, revocations, startEntered, releaseStart, pollEntered, releasePoll };
}

test('reopen uses only the active verified URL; account center uses the session origin without proof', async t => {
  const f = await fixture(t); const started = await f.client.beginBrowserLogin({ serverUrl: f.origin });
  assert.equal(started.browserOpened, true); assert.equal('deviceCode' in started, false); assert.equal('verifier' in started, false);
  await assert.rejects(f.client.openBrowserLogin({ id: 'wrong-attempt' }), /过期/);
  await f.client.openBrowserLogin({ id: started.id });
  assert.deepEqual(f.opened, [started.verificationUrl, started.verificationUrl]);
  assert.equal((await f.client.pollBrowserLogin({ id: started.id })).account.loggedIn, true);
  await f.client.openAccountCenter(); assert.equal(f.opened.at(-1), f.origin + '/account/');
  assert.ok(f.opened.every(url => !url.includes('private-device-proof') && !url.includes('synthetic-access-token')));
  await f.client.logout(); await assert.rejects(f.client.openAccountCenter(), /先登录/);
});

test('failed OS opener returns a usable public handoff without leaking or discarding the proof', async t => {
  const f = await fixture(t, { failOpen: true });
  const result = await f.client.beginBrowserLogin({ serverUrl: f.origin });
  assert.equal(result.browserOpened, false); assert.ok(result.verificationUrl.includes('#authorize'));
  await assert.rejects(f.client.openBrowserLogin({ id: result.id }), /opener/);
  assert.equal((await f.client.pollBrowserLogin({ id: result.id })).account.loggedIn, true);
});

test('cancel while auth-start is in flight prevents opening or resurrecting the late attempt', async t => {
  const f = await fixture(t, { delayedStart: true });
  const started = f.client.beginBrowserLogin({ serverUrl: f.origin });
  const rejected = assert.rejects(started, /取消/);
  await f.startEntered.promise; f.client.cancelBrowserLogin(); f.releaseStart.resolve(); await rejected;
  assert.deepEqual(f.opened, []); assert.equal((await f.client.status()).loggedIn, false);
});

test('cancel while poll is in flight revokes late credentials and does not persist a session', async t => {
  const f = await fixture(t, { delayedPoll: true }); const started = await f.client.beginBrowserLogin({ serverUrl: f.origin });
  const polling = f.client.pollBrowserLogin({ id: started.id }); const rejected = assert.rejects(polling, /取消/);
  await f.pollEntered.promise; f.client.cancelBrowserLogin(); f.releasePoll.resolve(); await rejected;
  assert.equal(f.revocations.length, 1); assert.equal((await f.client.status()).loggedIn, false);
  await assert.rejects(fs.access(path.join(f.directory, 'Trylo/remote/relay-session.json')));
});

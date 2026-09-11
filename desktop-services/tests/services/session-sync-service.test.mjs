// session-sync-service.mjs：会话镜像的降级语义（spec §7.4）。
// 纯 Node 单测 —— 通过 seam 注入 fake sync，不 spawn Python。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createSessionSyncService } from '../../src/learning/session-sync-service.mjs';

const STORAGE_ROOT = path.join('/data', 'app', 'Trylo');

function fakeSync(overrides = {}) {
  const calls = [];
  let logger = null;
  return {
    calls,
    sync: {
      setLogger: (fn) => { logger = fn; calls.push({ method: 'setLogger' }); },
      mirrorSession: async (session, storagePath) => {
        calls.push({ method: 'mirrorSession', session, storagePath });
        if (overrides.mirrorError) throw new Error(overrides.mirrorError);
        return overrides.mirrored ?? true;
      },
      rebuildIndex: async (sessions, storagePath) => {
        calls.push({ method: 'rebuildIndex', sessions, storagePath });
        if (overrides.rebuildError) throw new Error(overrides.rebuildError);
        return overrides.rebuildResult ?? { indexed: sessions.length };
      },
      shutdown: () => {
        calls.push({ method: 'shutdown' });
        if (overrides.shutdownError) throw new Error(overrides.shutdownError);
      },
    },
  };
}

const SESSION = {
  id: 'session-1',
  title: 'Demo',
  workspace: { path: 'd:/repo' },
  model: 'claude-sonnet-4',
  turns: [{ prompt: 'hi', resultText: 'hello', startedAt: '2026-08-28T00:00:00Z' }],
};

test('syncSession mirrors the projected session with the storage root', async () => {
  const { calls, sync } = fakeSync({ mirrored: true });
  const service = createSessionSyncService({ storageRoot: STORAGE_ROOT, sync });
  const result = await service.syncSession(SESSION);
  assert.deepEqual(result, { ok: true, mirrored: true });
  const call = calls.find((c) => c.method === 'mirrorSession');
  assert.equal(call.storagePath, STORAGE_ROOT);
  assert.deepEqual(call.session, SESSION);
});

test('syncSession reports "nothing to mirror" when the projection has no id', async () => {
  const { calls, sync } = fakeSync();
  const service = createSessionSyncService({ storageRoot: STORAGE_ROOT, sync });
  assert.deepEqual(await service.syncSession(null), { ok: true, mirrored: false });
  assert.deepEqual(await service.syncSession({ turns: [] }), { ok: true, mirrored: false });
  assert.equal(calls.some((c) => c.method === 'mirrorSession'), false);
});

test('syncSession uninstalls the logger — a mirror failure never blocks the task', async () => {
  const logged = [];
  const { calls, sync } = fakeSync({ mirrorError: 'session_adapter exited 1' });
  const service = createSessionSyncService({
    storageRoot: STORAGE_ROOT,
    sync,
    log: (m) => logged.push(m),
  });
  const result = await service.syncSession(SESSION);
  assert.equal(result.ok, false);
  assert.equal(result.mirrored, false);
  assert.equal(result.error, 'session_adapter exited 1');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /session_adapter exited 1/);
});

test('rebuild passes the sessions through and returns the legacy result', async () => {
  const { calls, sync } = fakeSync();
  const service = createSessionSyncService({ storageRoot: STORAGE_ROOT, sync });
  const result = await service.rebuild([SESSION]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { indexed: 1 });
  assert.equal(calls.at(-1).storagePath, STORAGE_ROOT);
});

test('rebuild tolerates a non-array input and reports failures', async () => {
  const { sync } = fakeSync();
  const service = createSessionSyncService({ storageRoot: STORAGE_ROOT, sync });
  const ok = await service.rebuild(null);
  assert.deepEqual(ok.result, { indexed: 0 });

  const { sync: broken } = fakeSync({ rebuildError: 'boom' });
  const failing = createSessionSyncService({ storageRoot: STORAGE_ROOT, sync: broken });
  const result = await failing.rebuild([SESSION]);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'boom');
});

test('shutdown is idempotent before first use', async () => {
  const { calls, sync } = fakeSync();
  const service = createSessionSyncService({ storageRoot: STORAGE_ROOT, sync });
  assert.deepEqual(await service.shutdown(), { ok: true, stopped: false });
  assert.deepEqual(calls, []);

  await service.syncSession(SESSION);
  assert.deepEqual(await service.shutdown(), { ok: true, stopped: true });
});

test('shutdown failure is reported, not thrown', async () => {
  const { sync } = fakeSync({ shutdownError: 'flush failed' });
  const service = createSessionSyncService({ storageRoot: STORAGE_ROOT, sync });
  await service.syncSession(SESSION);
  const result = await service.shutdown();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'flush failed');
});

test('unconfigured storage root degrades without touching the adapter', async () => {
  const { calls, sync } = fakeSync();
  const service = createSessionSyncService({ storageRoot: '', sync });
  const mirrored = await service.syncSession(SESSION);
  assert.equal(mirrored.ok, false);
  assert.match(mirrored.error, /storage root is not configured/);

  const rebuilt = await service.rebuild([SESSION]);
  assert.equal(rebuilt.ok, false);
  assert.equal(calls.some((c) => c.method !== 'setLogger'), false);
});

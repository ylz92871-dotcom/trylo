// pending-admin-service.mjs：staged 写入的失败关闭语义（spec §7.5 / arch §6.3）。
// 纯 Node 单测 —— 通过 seam 注入 fake admin，不 spawn Python。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createPendingAdminService } from '../../src/learning/pending-admin-service.mjs';

const STORAGE_ROOT = path.join('/data', 'app', 'Trylo');

function fakeAdmin(result) {
  const calls = [];
  const admin = {
    listPendingAsync: async (root, opts) => {
      calls.push({ method: 'listPendingAsync', root, opts });
      return result.list ?? { success: true, pending: [{ id: 'p1' }], count: 1 };
    },
    applySkillWithSnapshotAsync: async (root, params, opts) => {
      calls.push({ method: 'applySkillWithSnapshotAsync', root, params, opts });
      return result.apply ?? { success: true, applied: 1 };
    },
    proposeSkillAsync: async (root, params, opts) => {
      calls.push({ method: 'proposeSkillAsync', root, params, opts });
      return result.propose ?? { success: true, pendingId: 'p2' };
    },
    listSkillBackupsAsync: async (root, opts) => {
      calls.push({ method: 'listSkillBackupsAsync', root, opts });
      return result.backups ?? { success: true, backups: [{ id: 'snap-1' }] };
    },
    rollbackSkillBackupAsync: async (root, snapshotId, opts) => {
      calls.push({ method: 'rollbackSkillBackupAsync', root, snapshotId, opts });
      return result.rollback ?? { success: true, restored: 'snap-1' };
    },
    runAdminAsync: async (root, params, opts) => {
      calls.push({ method: 'runAdminAsync', root, params, opts });
      return result.run ?? { success: true, item: { id: params?.id ?? null } };
    },
  };
  return { calls, admin };
}

test('list: ok + pending + count pass through', async () => {
  const { calls, admin } = fakeAdmin({});
  const service = createPendingAdminService({ storageRoot: STORAGE_ROOT, admin });
  const result = await service.list();
  assert.equal(result.ok, true);
  assert.deepEqual(result.pending, [{ id: 'p1' }]);
  assert.equal(result.count, 1);
  assert.equal(calls[0].root, STORAGE_ROOT);
});

test('list: infrastructure failure is reported, never shown as "no pending"', async () => {
  const { admin } = fakeAdmin({
    list: { success: false, pending: [], count: 0, error: 'admin.py exited 1' },
  });
  const service = createPendingAdminService({ storageRoot: STORAGE_ROOT, admin });
  const result = await service.list();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'admin.py exited 1');
  assert.deepEqual(result.pending, []);
});

test('apply is fail-closed: missing expectedHash never reaches Python', async () => {
  const { calls, admin } = fakeAdmin({});
  const service = createPendingAdminService({ storageRoot: STORAGE_ROOT, admin });

  await assert.rejects(
    () => service.apply({ subsystem: 'skills', id: 'p1' }),
    (err) => err.code === 'MISSING_HASH' && /expectedHash/.test(err.message),
  );
  // 必须在 spawn 前拒绝过期的 UI 提交。
  assert.deepEqual(calls, []);
});

test('apply is fail-closed: missing pendingId never reaches Python', async () => {
  const { calls, admin } = fakeAdmin({});
  const service = createPendingAdminService({ storageRoot: STORAGE_ROOT, admin });
  await assert.rejects(() => service.apply({ subsystem: 'skills', expectedHash: 'h1' }), /pendingId/);
  assert.deepEqual(calls, []);
});

test('apply with pendingId + expectedHash delegates to the snapshot path', async () => {
  const { calls, admin } = fakeAdmin({});
  const service = createPendingAdminService({ storageRoot: STORAGE_ROOT, admin });
  const result = await service.apply({ subsystem: 'skills', id: 'p1', expectedHash: 'sha256:abc', reason: 'reviewed' });
  assert.equal(result.ok, true);
  assert.equal(calls[0].method, 'applySkillWithSnapshotAsync');
  assert.deepEqual(calls[0].params, { id: 'p1', expectedHash: 'sha256:abc', reason: 'reviewed' });
});

test('skill apply that ran but did NOT commit (committed:false, kept pending) is a failure with the official reason surfaced', async () => {
  // admin.py returns success:true for the transaction even when the official
  // apply rejects the content (e.g. missing YAML frontmatter) and keeps the
  // proposal pending. The service must NOT report that as ok.
  const { admin } = fakeAdmin({
    apply: {
      success: true,
      committed: false,
      kept_pending: true,
      backupState: 'snapshot_ok',
      lastError: 'SKILL.md must start with YAML frontmatter (---). See existing skills for format.',
      result: { success: false, error: 'SKILL.md must start with YAML frontmatter (---). See existing skills for format.' },
    },
  });
  const service = createPendingAdminService({ storageRoot: STORAGE_ROOT, admin });
  const result = await service.apply({ subsystem: 'skills', id: 'p1', expectedHash: 'sha256:abc' });
  assert.equal(result.ok, false);
  assert.match(result.error, /YAML frontmatter/);
});

test('memory apply uses the generic official admin operation', async () => {
  const { calls, admin } = fakeAdmin({});
  const service = createPendingAdminService({ storageRoot: STORAGE_ROOT, admin });
  const result = await service.apply({
    subsystem: 'memory',
    id: 'm1',
    expectedHash: 'sha256:def',
    reason: 'reviewed',
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].method, 'runAdminAsync');
  assert.deepEqual(calls[0].params, {
    op: 'apply',
    subsystem: 'memory',
    id: 'm1',
    expectedHash: 'sha256:def',
    reason: 'reviewed',
  });
});

test('detail / discard use the admin op contract', async () => {
  const { calls, admin } = fakeAdmin({});
  const service = createPendingAdminService({ storageRoot: STORAGE_ROOT, admin });

  await service.detail({ subsystem: 'skills', id: 'p1' });
  assert.deepEqual(calls.at(-1).params, { op: 'get', subsystem: 'skills', id: 'p1' });

  await service.discard({ subsystem: 'memory', id: 'p9' });
  assert.deepEqual(calls.at(-1).params, { op: 'discard', subsystem: 'memory', id: 'p9' });
});

test('unknown subsystem or missing id is rejected before Python', async () => {
  const { calls, admin } = fakeAdmin({});
  const service = createPendingAdminService({ storageRoot: STORAGE_ROOT, admin });

  await assert.rejects(() => service.detail({ subsystem: 'hacks', id: 'p1' }), /unknown pending subsystem/);
  await assert.rejects(() => service.apply({ subsystem: 'hacks', id: 'p1', expectedHash: 'h1' }), /unknown pending subsystem/);
  await assert.rejects(() => service.detail({ subsystem: 'skills' }), /requires an id/);
  await assert.rejects(() => service.discard({ subsystem: 'skills' }), /requires an id/);
  assert.deepEqual(calls, []);
});

test('backup list + rollback require a snapshot id from listBackups', async () => {
  const { calls, admin } = fakeAdmin({});
  const service = createPendingAdminService({ storageRoot: STORAGE_ROOT, admin });

  const backups = await service.listBackups();
  assert.equal(backups.ok, true);
  assert.deepEqual(backups.backups, [{ id: 'snap-1' }]);

  const rolled = await service.rollback({ snapshotId: 'snap-1' });
  assert.equal(rolled.ok, true);
  assert.equal(calls.at(-1).snapshotId, 'snap-1');

  await assert.rejects(() => service.rollback({}), /snapshotId/);
});

test('proposeSkill stages only — it never applies', async () => {
  const { calls, admin } = fakeAdmin({});
  const service = createPendingAdminService({ storageRoot: STORAGE_ROOT, admin });
  const result = await service.proposeSkill({ action: 'add_or_update', name: 'demo' });
  assert.equal(result.ok, true);
  assert.equal(calls[0].method, 'proposeSkillAsync');
  await assert.rejects(() => service.proposeSkill({}), /requires an action/);
});

test('unconfigured storage root is rejected (NOT_CONFIGURED)', async () => {
  const { calls, admin } = fakeAdmin({});
  const service = createPendingAdminService({ storageRoot: '', admin });
  await assert.rejects(
    () => service.list(),
    (err) => err.code === 'NOT_CONFIGURED',
  );
  assert.deepEqual(calls, []);
});

test('timeoutMs is forwarded to the vendored admin calls', async () => {
  const { calls, admin } = fakeAdmin({});
  const service = createPendingAdminService({ storageRoot: STORAGE_ROOT, admin, timeoutMs: 1234 });
  await service.list();
  assert.equal(calls[0].opts.timeoutMs, 1234);
});

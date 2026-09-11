import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFileMemento } from '../../src/learning/file-memento.mjs';
import { createJobsService } from '../../src/learning/jobs-service.mjs';

test('Desktop jobs service reuses registry/scheduler and runs index rebuild', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobs-service-'));
  const memento = createFileMemento({ storageRoot: root });
  const rebuilt = [];
  const service = createJobsService({
    storageRoot: root,
    memento,
    sessionSync: { rebuild: async (sessions) => { rebuilt.push(sessions); return { ok: true }; } },
    pending: { listBackups: async () => ({ ok: true, backups: [] }) },
    curation: { qualityScan: async () => ({ ok: true, signals: 0, candidates: [] }) },
    historyMining: { run: async () => ({ ok: true, status: 'ok', candidates: [], errors: [] }) },
    health: { health: async () => ({ available: true }) },
  });
  assert.equal((await service.start()).ok, true);
  const added = await service.manage({
    action: 'register', jobId: 'rebuild', type: 'index-rebuild',
    intervalMs: 60_000, enabled: false,
  });
  assert.equal(added.ok, true);
  const run = await service.manage({
    action: 'runNow', jobId: 'rebuild',
    sessions: [{ id: 's1', title: 'one', workspace: { path: 'd:/repo' }, turns: [] }],
  });
  assert.equal(run.ok, true);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0][0].id, 's1');
  const listed = await service.manage({ action: 'list' });
  assert.equal(listed.jobs.length, 1);
  await service.stop();
});

test('B-level jobs require a positive model-call budget', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobs-budget-'));
  const service = createJobsService({
    storageRoot: root,
    memento: createFileMemento({ storageRoot: root }),
    sessionSync: { rebuild: async () => ({ ok: true }) },
    pending: { listBackups: async () => ({ ok: true, backups: [] }) },
    curation: { qualityScan: async () => ({ ok: true, signals: 0, candidates: [] }) },
    historyMining: { run: async () => ({ ok: true, status: 'ok', candidates: [], errors: [] }) },
    health: { health: async () => ({ available: true }) },
  });
  const result = await service.manage({
    action: 'register', jobId: 'quality', type: 'quality-scan', intervalMs: 60_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'BUDGET_REQUIRED');
  await service.stop();
});

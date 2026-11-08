import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFileMemento, LEGACY_STATE_KEY, stateFilePath } from './file-memento.mjs';

// Test-only old behavior selection for recorded red assertions.
const strictPolicy = process.env.TRYLO_HERMES_TEST_LEGACY_RESET === '1' ? 'legacy_reset' : 'fail_closed';
const corrupt = error => error?.code === 'HERMES_LEARNING_STATE_CORRUPT' && error.message === 'HERMES_LEARNING_STATE_CORRUPT';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trylo-memento-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = stateFilePath(root);
  await mkdir(path.dirname(file), { recursive: true });
  return { root, file, put: raw => writeFile(file, raw, 'utf8') };
}

test('strict missing storage is empty and the original v1 state can be committed', async t => {
  const f = await fixture(t), memento = createFileMemento({ storageRoot: f.root, corruptionPolicy: strictPolicy });
  assert.equal(memento.get(LEGACY_STATE_KEY, 'absent'), 'absent');
  const state = { schemaVersion: 1, workspaces: { workspace: { processedEvidenceHashes: ['old-format-hash'] } } };
  await memento.update(LEGACY_STATE_KEY, state);
  assert.deepEqual(memento.get(LEGACY_STATE_KEY), state);
});

test('strict damaged JSON or outer shape cannot erase evidence on read or update', async t => {
  const f = await fixture(t), logs = [];
  const memento = createFileMemento({ storageRoot: f.root, corruptionPolicy: strictPolicy, log: text => logs.push(text) });
  for (const raw of ['{"private":"private-state-secret",', 'null', '[]', '"private-state-secret"']) {
    await f.put(raw);
    assert.throws(() => memento.get(LEGACY_STATE_KEY, 'empty'), corrupt);
    await assert.rejects(memento.update('unrelated-key', 'new'), corrupt);
    assert.equal(await readFile(f.file, 'utf8'), raw);
  }
  assert.equal(logs.some(message => message.includes('private-state-secret') || message.includes(f.root)), false);
});

test('strict rejects broken existing v1 deduplication facts without constraining optional domains', async t => {
  const f = await fixture(t), memento = createFileMemento({ storageRoot: f.root, corruptionPolicy: strictPolicy });
  const invalid = [null, {}, { schemaVersion: 2, workspaces: {} }, { schemaVersion: 1 },
    { schemaVersion: 1, workspaces: [] }, { schemaVersion: 1, workspaces: { w: null } },
    { schemaVersion: 1, workspaces: { w: {} } }, { schemaVersion: 1, workspaces: { w: { processedEvidenceHashes: 'hash' } } },
    { schemaVersion: 1, workspaces: { w: { processedEvidenceHashes: [42] } } }];
  for (const state of invalid) {
    const raw = JSON.stringify({ [LEGACY_STATE_KEY]: state });
    await f.put(raw);
    assert.throws(() => memento.get(LEGACY_STATE_KEY), corrupt);
    await assert.rejects(memento.update('another-key', true), corrupt);
    assert.equal(await readFile(f.file, 'utf8'), raw);
  }
});

test('strict preserves optional defaults, old string hashes, long history and top-level extensions', async t => {
  const f = await fixture(t), memento = createFileMemento({ storageRoot: f.root, corruptionPolicy: strictPolicy });
  const state = { schemaVersion: 1, workspaces: { w: { processedEvidenceHashes: Array.from({ length: 120 }, (_, index) => `legacy-${index}`) } },
    historyMining: { retained: true }, skillQuality: { opaque: 'existing' }, jobs: { version: 'existing' }, futureExtension: { preserved: true } };
  await f.put(JSON.stringify({ [LEGACY_STATE_KEY]: state, unrelatedTopLevel: { keep: true } }));
  assert.deepEqual(memento.get(LEGACY_STATE_KEY), state);
  await memento.update('another-key', { added: true });
  const persisted = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(persisted[LEGACY_STATE_KEY], state);
  assert.deepEqual(persisted.unrelatedTopLevel, { keep: true });
});

test('legacy compatibility default still resets invalid JSON and non-object files', async t => {
  const f = await fixture(t), memento = createFileMemento({ storageRoot: f.root });
  for (const raw of ['{broken', '[]', 'null']) {
    await f.put(raw);
    assert.equal(memento.get(LEGACY_STATE_KEY, 'default'), 'default');
    await memento.update('unrelated-key', 'value');
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), { 'unrelated-key': 'value' });
  }
});

test('strict rejects a corrupt new value before overwriting the last valid state', async t => {
  const f = await fixture(t), memento = createFileMemento({ storageRoot: f.root, corruptionPolicy: strictPolicy });
  await memento.update(LEGACY_STATE_KEY, { schemaVersion: 1, workspaces: {} });
  const before = await readFile(f.file, 'utf8');
  await assert.rejects(memento.update(LEGACY_STATE_KEY, { schemaVersion: 1, workspaces: { w: {} } }), corrupt);
  assert.equal(await readFile(f.file, 'utf8'), before);
});

// file-memento.mjs：Memento 形状、原子写、并发串行、损坏降级（spec §7.2）。
// 纯 Node，不 spawn Python。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createFileMemento,
  stateFilePath,
  STATE_FILE_NAME,
  LEGACY_STATE_KEY,
} from '../../src/learning/file-memento.mjs';

let root;
const require = createRequire(import.meta.url);
const legacyLearningState = require('../../vendor/legacy/learning-loop/learning-state.js');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'file-memento-'));
});

test('state file lives under <root>/learning/state-v1.json', () => {
  assert.equal(stateFilePath(root), path.join(root, 'learning', STATE_FILE_NAME));
});

test('get returns the default value when nothing was written', async () => {
  const memento = createFileMemento({ storageRoot: root });
  assert.equal(memento.get(LEGACY_STATE_KEY) instanceof Promise, false,
    'VS Code Memento.get contract is synchronous');
  assert.equal(await memento.get(LEGACY_STATE_KEY), undefined);
  assert.deepEqual(await memento.get(LEGACY_STATE_KEY, { version: 1 }), { version: 1 });
});

test('legacy learning-state reads the persisted blob synchronously', async () => {
  const memento = createFileMemento({ storageRoot: root });
  const state = { schemaVersion: 1, workspaces: { repo: { meaningfulIterations: 7 } } };
  await memento.update(LEGACY_STATE_KEY, state);
  assert.deepEqual(legacyLearningState.loadState(memento), state);
});

test('update persists the legacy state blob verbatim (no second schema)', async () => {
  const memento = createFileMemento({ storageRoot: root });
  const state = {
    version: 1,
    histories: [{ sessionId: 's1', reviewedAt: '2026-08-28T00:00:00Z', status: 'ok' }],
    totals: { tasks: 3, tools: 4 },
  };
  await memento.update(LEGACY_STATE_KEY, state);
  assert.deepEqual(await memento.get(LEGACY_STATE_KEY), state);

  // 磁盘上只有一个 key/value blob，不引入第二套 schema。
  const raw = JSON.parse(readFileSync(memento.filePath, 'utf8'));
  assert.deepEqual(Object.keys(raw), [LEGACY_STATE_KEY]);
  assert.equal(raw[LEGACY_STATE_KEY].version, 1);
});

test('concurrent updates are serialized — no lost writes', async () => {
  const memento = createFileMemento({ storageRoot: root });
  await Promise.all([
    memento.update('a', 1),
    memento.update('b', 2),
    memento.update('c', 3),
  ]);
  const raw = JSON.parse(readFileSync(memento.filePath, 'utf8'));
  assert.deepEqual(raw, { a: 1, b: 2, c: 3 });
});

test('update overwrites, get distinguishes stored falsy values from missing', async () => {
  const memento = createFileMemento({ storageRoot: root });
  await memento.update('k', 0);
  assert.equal(await memento.get('k', 42), 0);
  assert.equal(await memento.get('missing', 42), 42);
});

test('a corrupt file degrades to an empty memento instead of crashing', async () => {
  const memento = createFileMemento({ storageRoot: root });
  mkdirSync(path.dirname(stateFilePath(root)), { recursive: true });
  writeFileSync(stateFilePath(root), '{not json', 'utf8');
  assert.equal(await memento.get(LEGACY_STATE_KEY), undefined);
});

test('update rejects when the storage root is not configured', async () => {
  const messages = [];
  const memento = createFileMemento({ storageRoot: '', log: (m) => messages.push(m) });
  await assert.rejects(() => memento.update('k', 1), /storageRoot/);
  assert.equal(messages.length, 1);
});

test('get never creates the file (read path stays side-effect free)', async () => {
  const memento = createFileMemento({ storageRoot: root });
  await memento.get(LEGACY_STATE_KEY);
  assert.equal(existsSync(memento.filePath), false);
});

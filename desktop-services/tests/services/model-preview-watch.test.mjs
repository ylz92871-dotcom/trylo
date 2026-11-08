import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModelPreviewWatch } from '../../src/tooling/model-preview-watch.mjs';
import { previewInput } from '../../src/tooling/model-preview-contract.mjs';

test('explicit camera coordinates require both position and target', () => {
  assert.throws(() => previewInput('view', { position: [1, 2, 3] }), /invalid_camera_pair/);
  assert.throws(() => previewInput('view', { target: [0, 0, 0] }), /invalid_camera_pair/);
  assert.deepEqual(previewInput('view', { position: [1, 2, 3], target: [0, 0, 0] }), { position: [1, 2, 3], target: [0, 0, 0] });
});

test('project watchers coalesce resource changes, allow product outputs and stop after the last scene closes', () => {
  const changed = [], queued = new Map();
  let events, opened = 0, closed = 0, sequence = 0;
  const watcher = createModelPreviewWatch({
    changed: (session, generation) => changed.push([session.scope, generation]),
    watch(_root, options, callback) {
      assert.equal(options.recursive, true);
      opened += 1; events = callback;
      return { on() {}, unref() {}, close() { closed += 1; } };
    },
    schedule(callback, delay) { assert.equal(delay, 120); queued.set(++sequence, callback); return sequence; },
    cancel: id => queued.delete(id),
  });
  const first = { scope: 'first', projectRoot: '/workspace' }, second = { scope: 'second', projectRoot: '/workspace' };
  watcher.open(first); watcher.open(second);
  assert.equal(opened, 1);
  for (const filename of ['.trylo/tmp/private.glb', '.trylo/runtime/browser/screenshot.png', '.git/private.png', 'node_modules/asset.glb', 'notes.txt']) events('change', filename);
  assert.equal(queued.size, 0);
  events('change', '.trylo/out/model.glb');
  events('change', 'assets/material.png');
  assert.equal(queued.size, 1);
  for (const callback of queued.values()) callback(); queued.clear();
  assert.deepEqual(changed, [['first', 1], ['second', 1]]);
  watcher.close(first);
  assert.equal(closed, 0);
  events('rename', 'dist/model.glb');
  for (const callback of queued.values()) callback(); queued.clear();
  assert.deepEqual(changed.at(-1), ['second', 2]);
  watcher.close(second);
  assert.equal(closed, 1);
  watcher.dispose();
  assert.equal(closed, 1);
});

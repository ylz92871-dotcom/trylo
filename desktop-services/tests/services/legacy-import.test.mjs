// legacy-import.mjs：老数据导入（discover → copy → verify → mark，spec §7.5）。
// 纯 Node 单测 —— 用临时目录，绝不触碰真实的 VS Code globalStorage。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLegacyImportService } from '../../src/learning/legacy-import.mjs';

let storageRoot;
let legacyRoot;

function legacyHome() {
  return path.join(legacyRoot, 'hermes-capabilities', 'v1');
}

function targetHome() {
  return path.join(storageRoot, 'hermes-capabilities', 'v1');
}

beforeEach(() => {
  storageRoot = mkdtempSync(path.join(tmpdir(), 'import-target-'));
  legacyRoot = mkdtempSync(path.join(tmpdir(), 'import-source-'));
  mkdirSync(path.join(legacyHome(), 'memory'), { recursive: true });
  writeFileSync(path.join(legacyHome(), 'memory', 'MEMORY.md'), '# memory\n', 'utf8');
  writeFileSync(path.join(legacyHome(), 'config.yaml'), 'version: 1\n', 'utf8');
});

test('plan finds a legacy Hermes home and reports the empty target', async () => {
  const service = createLegacyImportService({ storageRoot });
  const plan = await service.plan({ candidates: [legacyRoot] });
  assert.equal(plan.ok, true);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].source, legacyRoot);
  assert.equal(plan.candidates[0].files, 2);
  assert.equal(plan.target.files, 0);
  assert.equal(plan.alreadyImported, null);
});

test('plan is read-only and never throws without candidates', async () => {
  const service = createLegacyImportService({ storageRoot });
  const plan = await service.plan({ candidates: [path.join(legacyRoot, 'nope')] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.candidates, []);
  assert.equal(existsSync(targetHome()), false);
});

test('commit copies the legacy home and marks it imported', async () => {
  const service = createLegacyImportService({ storageRoot });
  const result = await service.commit({ source: legacyRoot });

  assert.equal(result.ok, true);
  assert.equal(result.copied, 2);
  assert.equal(result.skippedFiles, 0);
  assert.equal(result.verified, true);
  assert.equal(readFileSync(path.join(targetHome(), 'memory', 'MEMORY.md'), 'utf8'), '# memory\n');

  const marker = JSON.parse(readFileSync(path.join(storageRoot, 'hermes-capabilities', 'trylo-import-marker.json'), 'utf8'));
  assert.equal(marker.source, legacyRoot);
  assert.equal(marker.copied, 2);
});

test('the old location is never deleted (copy, not move)', async () => {
  const service = createLegacyImportService({ storageRoot });
  await service.commit({ source: legacyRoot });
  assert.equal(existsSync(path.join(legacyHome(), 'config.yaml')), true);
  assert.equal(existsSync(path.join(legacyHome(), 'memory', 'MEMORY.md')), true);
});

test('re-running commit is a no-op — existing files are skipped, never overwritten', async () => {
  const service = createLegacyImportService({ storageRoot });
  const first = await service.commit({ source: legacyRoot });
  // Simulate Desktop-side edits that must survive a re-run.
  writeFileSync(path.join(targetHome(), 'config.yaml'), 'version: 2\n', 'utf8');

  const second = await service.commit({ source: legacyRoot });
  assert.equal(first.skipped, false);
  assert.equal(second.ok, true);
  assert.equal(second.skipped, true);
  assert.equal(readFileSync(path.join(targetHome(), 'config.yaml'), 'utf8'), 'version: 2\n');
});

test('commit rejects an unknown source instead of inventing data', async () => {
  const service = createLegacyImportService({ storageRoot });
  const result = await service.commit({ source: path.join(legacyRoot, 'nope') });
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);

  const missing = await service.commit({});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /requires a legacy source path/);
});

test('unconfigured storage root degrades in both phases', async () => {
  const service = createLegacyImportService({ storageRoot: '' });
  const plan = await service.plan({ candidates: [legacyRoot] });
  assert.equal(plan.ok, false);
  const commit = await service.commit({ source: legacyRoot });
  assert.equal(commit.ok, false);
});

test('default candidates point at the legacy VS Code extension id', async () => {
  const service = createLegacyImportService({ storageRoot });
  const candidates = (await import('../../src/learning/legacy-import.mjs')).defaultLegacyCandidates({
    APPDATA: 'C:/Users/demo/AppData/Roaming',
  });
  assert.deepEqual(candidates, [
    path.join('C:/Users/demo/AppData/Roaming', 'Code', 'User', 'globalStorage', 'local.trylo-code'),
    path.join('C:/Users/demo/AppData/Roaming', 'Code - Insiders', 'User', 'globalStorage', 'local.trylo-code'),
  ]);
  assert.equal(typeof service.plan, 'function');
});

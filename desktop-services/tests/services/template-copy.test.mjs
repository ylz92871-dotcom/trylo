// template-copy.mjs — PR-6 apply-time privileged copy (spec §5 / §2.8).
// Pure Node: temp dirs, no Hermes spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { copyTemplateUnderOut, validateOutRelPath, validateDestAbs } from '../../src/learning/template-copy.mjs';

function layout() {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'tpl-ws-'));
  const hermesHome = mkdtempSync(path.join(tmpdir(), 'tpl-hermes-'));
  const outRoot = path.join(workspaceRoot, '.trylo', 'out');
  mkdirSync(outRoot, { recursive: true });
  return { workspaceRoot, hermesHome, outRoot };
}

/** Direct-call helper — mirrors the index.mjs wrapper that injects hermesHome. */
function copyWith(hermesHome, params) {
  return copyTemplateUnderOut({ ...params, hermesHome });
}

function writeDeliverable(outRoot, name, text = 'hello pptx') {
  const abs = path.join(outRoot, name);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
  return abs;
}

test('validateOutRelPath: shape rules', () => {
  assert.equal(validateOutRelPath('.trylo/out/周报.pptx'), null);
  assert.equal(validateOutRelPath('.trylo/outbox/x.pptx'), 'not_under_out');
  assert.equal(validateOutRelPath('out/x.pptx'), 'not_under_out');
  assert.equal(validateOutRelPath('.trylo/out/../x.pptx'), 'dotdot_segment');
  assert.equal(validateOutRelPath('C:/abs/x.pptx'), 'absolute_path');
  assert.equal(validateOutRelPath('.trylo/out'), 'not_under_out');
});

test('validateDestAbs: must stay inside <hermesHome>/skills/', () => {
  const home = 'C:/hermes/v1';
  assert.equal(validateDestAbs(`${home}/skills/work-presentation/templates/q3.pptx`, home), null);
  assert.equal(validateDestAbs(`${home}/skills/work-presentation/templates/q3.pptx`, 'C:/hermes/v2'), 'dest_outside_skills');
  assert.equal(validateDestAbs(`C:/other/skills/x.pptx`, home), 'dest_outside_skills');
  assert.equal(validateDestAbs(`${home}/skills/x/../../escape.pptx`, home), 'dest_outside_skills');
});

test('copies a deliverable into HERMES_HOME/skills/<name>/templates/<slug>.pptx', async () => {
  const { workspaceRoot, hermesHome, outRoot } = layout();
  const src = writeDeliverable(outRoot, '周报.pptx', 'deck bytes');
  const stat = statSync(src);
  const destAbs = `${hermesHome}/skills/work-presentation/templates/weekly-report.pptx`;
  const res = await copyWith(hermesHome, {
    workspaceRoot,
    sourceRel: '.trylo/out/周报.pptx',
    destAbs,
    expectedBytes: stat.size,
    expectedMtimeMs: stat.mtimeMs,
  });
  assert.deepEqual(res, { ok: true, copied: true, destAbs, bytes: stat.size });
  // Verify the bytes actually landed.
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(destAbs, 'utf8'), 'deck bytes');
});

test('missing source → ok:true copied:false template_copy_missing_source (Skill still applied)', async () => {
  const { workspaceRoot, hermesHome } = layout();
  const res = await copyWith(hermesHome, {
    workspaceRoot,
    sourceRel: '.trylo/out/gone.pptx',
    destAbs: `${hermesHome}/skills/x/templates/gone.pptx`,
  });
  assert.equal(res.ok, true);
  assert.equal(res.copied, false);
  assert.equal(res.reasonCode, 'template_copy_missing_source');
});

test('no skillName (empty origin map value) → still ok:true copied:false', async () => {
  // The renderer never passes skillName; the guard is: destAbs must be a real
  // skills path. Here we simulate the "map has no skillName" case by giving a
  // destAbs that is NOT under skills/ — the sidecar refuses.
  const { workspaceRoot, hermesHome, outRoot } = layout();
  writeDeliverable(outRoot, 'a.pptx');
  const res = await copyWith(hermesHome, {
    workspaceRoot,
    sourceRel: '.trylo/out/a.pptx',
    destAbs: `${hermesHome}/templates/a.pptx`,
  });
  assert.equal(res.ok, true);
  assert.equal(res.copied, false);
  assert.equal(res.reasonCode, 'dest_outside_skills');
});

test('symlink source → not copied (symlink_source)', async (t) => {
  const { workspaceRoot, hermesHome, outRoot } = layout();
  const real = writeDeliverable(outRoot, 'real.pptx');
  try {
    symlinkSync(real, path.join(outRoot, 'link.pptx'));
  } catch {
    t.skip('symlinks unavailable on this platform');
    return;
  }
  const res = await copyWith(hermesHome, {
    workspaceRoot,
    sourceRel: '.trylo/out/link.pptx',
    destAbs: `${hermesHome}/skills/x/templates/link.pptx`,
  });
  assert.equal(res.ok, true);
  assert.equal(res.copied, false);
  assert.equal(res.reasonCode, 'symlink_source');
});

test('>20 MiB source → not copied (too_large)', async () => {
  const { workspaceRoot, hermesHome, outRoot } = layout();
  const big = path.join(outRoot, 'big.pptx');
  const { open } = await import('node:fs/promises');
  const fh = await open(big, 'w');
  const buf = Buffer.alloc(64 * 1024, 0x61); // 64 KiB chunks
  for (let i = 0; i < 400; i += 1) await fh.write(buf); // ~25 MiB
  await fh.close();
  const res = await copyWith(hermesHome, {
    workspaceRoot,
    sourceRel: '.trylo/out/big.pptx',
    destAbs: `${hermesHome}/skills/x/templates/big.pptx`,
  });
  assert.equal(res.ok, true);
  assert.equal(res.copied, false);
  assert.equal(res.reasonCode, 'too_large');
});

test('bad extension → not copied (bad_extension)', async () => {
  const { workspaceRoot, hermesHome, outRoot } = layout();
  writeDeliverable(outRoot, 'data.txt', 'x');
  const res = await copyWith(hermesHome, {
    workspaceRoot,
    sourceRel: '.trylo/out/data.txt',
    destAbs: `${hermesHome}/skills/x/templates/data.txt`,
  });
  assert.equal(res.ok, true);
  assert.equal(res.copied, false);
  assert.equal(res.reasonCode, 'bad_extension');
});

test('mtime/size drift >10% → not copied (size_drift / mtime_drift)', async () => {
  const { workspaceRoot, hermesHome, outRoot } = layout();
  const src = writeDeliverable(outRoot, 'drift.pptx', 'abc');
  const stat = statSync(src);
  const res = await copyWith(hermesHome, {
    workspaceRoot,
    sourceRel: '.trylo/out/drift.pptx',
    destAbs: `${hermesHome}/skills/x/templates/drift.pptx`,
    expectedBytes: stat.size * 2, // 2x → >10% drift
  });
  assert.equal(res.ok, true);
  assert.equal(res.copied, false);
  assert.equal(res.reasonCode, 'size_drift');
});

test('existing dest → not overwritten (dest_exists)', async () => {
  const { workspaceRoot, hermesHome, outRoot } = layout();
  writeDeliverable(outRoot, 'a.pptx');
  const destDir = path.join(hermesHome, 'skills', 'x', 'templates');
  mkdirSync(destDir, { recursive: true });
  writeFileSync(path.join(destDir, 'a.pptx'), 'OLD', 'utf8');
  const res = await copyWith(hermesHome, {
    workspaceRoot,
    sourceRel: '.trylo/out/a.pptx',
    destAbs: path.join(destDir, 'a.pptx'),
  });
  assert.equal(res.ok, true);
  assert.equal(res.copied, false);
  assert.equal(res.reasonCode, 'dest_exists');
});

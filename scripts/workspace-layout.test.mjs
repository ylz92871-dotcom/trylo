import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temporaryPath } from './workspace-paths.mjs';
import { inspectWorkspaceLayout } from './workspace-layout.mjs';

function fixture(t) {
  const base = temporaryPath('layout-contracts');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const file = relative => { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'fixture'); };
  return { root, file };
}

test('core source, formal tests, fixtures and native builds remain valid', t => {
  const { root, file } = fixture(t);
  for (const name of ['AGENTS.md', 'README.en.md', 'README.zh-CN.md', '.git', 'desktop/package.json', 'desktop/tests/result.snap', 'desktop/testdata/golden.png', 'desktop/node_modules/pkg/index.js', 'desktop/dist/index.html', 'new trylo cli/.agents/skills/quality/SKILL.md', '_workspace/tasks/run/failure.log']) file(name);
  assert.deepEqual(inspectWorkspaceLayout(root), { violations: [], pending: [], clean: true });
});

test('new root clutter and engine byproducts fail while nested golden fixtures pass', t => {
  const { root, file } = fixture(t);
  for (const name of ['CLAUDE.md', 'probe.log', 'output/report.json', 'desktop/Temp/run.txt', 'desktop/coverage/report.json', 'new trylo cli/dist-candidate/main.js', 'desktop/testdata/Temp/expected.json']) file(name);
  assert.deepEqual(inspectWorkspaceLayout(root).violations.map(item => item.path).sort(), ['CLAUDE.md', 'desktop/Temp', 'desktop/coverage', 'new trylo cli/dist-candidate', 'output', 'probe.log']);
});

test('pending moves are explicit debt and never exempt sibling outputs', t => {
  const { root, file } = fixture(t);
  file('Temp/active-run/data.json'); file('Temp/new-mess/report.txt');
  const exception = { path: 'Temp/active-run', reason: 'Existing active writer', evidence: '_workspace/tasks/preflight.json' };
  const result = inspectWorkspaceLayout(root, [exception]);
  assert.deepEqual(result.pending, [exception]);
  assert.equal(result.clean, false);
  assert.deepEqual(result.violations.map(item => item.path), ['Temp/new-mess']);
  assert.throws(() => inspectWorkspaceLayout(root, [{ path: '../Temp', reason: 'bad', evidence: 'bad' }]), /exact repository-relative/);
  for (const invalid of ['D:/Temp', 'D:Temp', './Temp', 'Temp/../other']) {
    assert.throws(() => inspectWorkspaceLayout(root, [{ ...exception, path: invalid }]), /exact repository-relative/);
  }
});

test('missing or uninspected pending entries cannot silently become clean', t => {
  const { root, file } = fixture(t);
  file('desktop/docs/old-log.txt');
  for (const relative of ['Temp/missing', 'desktop/docs/old-log.txt']) {
    const result = inspectWorkspaceLayout(root, [{ path: relative, reason: 'Existing debt', evidence: 'preflight.json' }]);
    assert.equal(result.clean, false);
    assert.match(result.violations[0].reason, /absent or outside inspected/);
  }
});

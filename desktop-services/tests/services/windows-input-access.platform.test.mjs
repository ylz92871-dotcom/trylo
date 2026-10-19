import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WINDOWS_INPUT_ACCESS_PROBE } from '../../src/tooling/windows-input-access.mjs';

test('a High Python token cannot hide the actual tool launcher Low label', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'trylo-launcher-label-'));
  const launcher = path.join(root, 'tool.exe');
  try {
    writeFileSync(launcher, 'label-only fixture; never executed');
    execFileSync('icacls.exe', [launcher, '/setintegritylevel', 'L'], { windowsHide: true });
    const probe = () => JSON.parse(execFileSync('python.exe', ['-B', '-c', WINDOWS_INPUT_ACCESS_PROBE, launcher], { encoding: 'utf8', windowsHide: true }));
    const low = probe();
    assert.ok(low.integrityRid >= 8192);
    assert.equal(low.entryIntegrityRid, 4096);
    assert.equal(low.effectiveIntegrityRid, 4096);
    execFileSync('icacls.exe', [launcher, '/setintegritylevel', 'M'], { windowsHide: true });
    assert.ok(probe().effectiveIntegrityRid >= 8192);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareOfficeRuntime } from './prepare-office-runtime.mjs';
const checkout = fileURLToPath(new URL('../../../', import.meta.url));
test('refuses a runtime outside the checkout before preparing anything', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(prepareOfficeRuntime(os.tmpdir()), /inside this checkout/);
});
test('refuses a byte-tampered executable without changing its integrity or data', { skip: process.platform !== 'win32' }, async () => {
  const base = path.join(checkout, '_workspace/tmp/office-runtime-tamper-fixtures');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'tampered-'));
  try {
    await mkdir(path.join(root, 'program'));
    await copyFile(path.join(checkout, 'desktop/src-tauri/resources/preview/office/manifest.json'), path.join(root, 'manifest.json'));
    const executable = path.join(root, 'program/soffice.com');
    await writeFile(executable, 'MZ-deliberately-invalid-fixture');
    const label = () => execFileSync('icacls.exe', [executable], { encoding: 'utf8', windowsHide: true });
    const before = label();
    await assert.rejects(prepareOfficeRuntime(root), /Office 引擎校验失败/);
    assert.equal(label(), before); assert.equal(await readFile(executable, 'utf8'), 'MZ-deliberately-invalid-fixture');
  } finally {
    // Resolve the exact owned fixture before recursive deletion on Windows.
    const resolved = await realpath(root), allowed = await realpath(base);
    if (path.dirname(resolved).toLowerCase() !== allowed.toLowerCase()) throw new Error('Fixture cleanup escaped its dedicated base');
    await rm(resolved, { recursive: true });
  }
});

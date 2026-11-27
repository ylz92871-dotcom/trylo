import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const preparation = fileURLToPath(new URL('./build/windows/prepare-native-dev-build.ps1', import.meta.url));
const system = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32');
const temporary = path.join(checkout, '_workspace/tmp/native-dev-build-tests');
const hostGroups = process.platform === 'win32' ? execFileSync(path.join(system, 'whoami.exe'), ['/groups', '/fo', 'csv'], { encoding: 'utf8', windowsHide: true }) : '';
const hostIntegrity = Number(hostGroups.match(/S-1-16-(\d+)/)?.[1] ?? 0);
const prepare = (build, integrity = 'M') => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', preparation, '-BuildDirectory', build, '-IntegrityLevel', integrity], { encoding: 'utf8', windowsHide: true });
const accessRules = file => execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `[IO.File]::GetAccessControl('${file.replaceAll("'", "''")}').GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)`],
{ encoding: 'utf8', windowsHide: true });

for (const [integrity, minimum] of [['M', 8192], ['H', 12288]]) test(`Cargo build-script preparation repairs ${integrity} resource overwrite and persists for new fingerprints`,
  { skip: process.platform !== 'win32' || hostIntegrity < minimum }, () => {
    mkdirSync(temporary, { recursive: true });
    const root = mkdtempSync(path.join(temporary, 'checkout-'));
    const build = path.join(root, 'src-tauri/target/debug/build');
    const worker = path.join(build, 'cached/build-script-build.exe');
    const input = path.join(root, 'new-resource.bin');
    const output = path.join(root, 'src-tauri/target/debug/runtime/resource.bin');
    try {
      mkdirSync(path.dirname(worker), { recursive: true });
      mkdirSync(path.dirname(output), { recursive: true });
      const binary = readFileSync(process.execPath);
      writeFileSync(worker, binary);
      writeFileSync(input, 'new verified resource');
      writeFileSync(output, 'old resource');
      execFileSync(path.join(system, 'icacls.exe'), [worker, '/setintegritylevel', 'L']);
      execFileSync(path.join(system, 'icacls.exe'), [output, '/setintegritylevel', integrity]);
      const copy = `const fs=require('node:fs');try{fs.copyFileSync(process.argv[1],process.argv[2]);console.log('copied')}
        catch(e){console.error(e.code);process.exitCode=1}`;
      const run = executable => spawnSync(executable, ['-e', copy, input, output], { encoding: 'utf8', windowsHide: true });
      const before = run(worker);
      assert.equal(before.status, 1);
      assert.match(before.stderr, /EPERM|EACCES/);
      const dacl = accessRules(worker);
      const prepared = prepare(build, integrity);
      assert.equal(prepared.status, 0, prepared.stderr);
      const after = run(worker);
      assert.equal(after.status, 0, after.stderr);
      assert.equal(readFileSync(output, 'utf8'), 'new verified resource');
      const future = path.join(build, 'new-fingerprint/build-script-build.exe');
      mkdirSync(path.dirname(future)); writeFileSync(future, binary);
      const next = run(future);
      assert.equal(next.status, 0, next.stderr);
      const afterDacl = accessRules(worker);
      assert.equal(afterDacl, dacl);
    } finally {
      assert.equal(path.dirname(root), path.resolve(temporary));
      rmSync(root, { recursive: true, force: true });
    }
  });

test('build preparation rejects unrelated paths and redirected build entries',
  { skip: process.platform !== 'win32' || hostIntegrity < 8192 }, () => {
    mkdirSync(temporary, { recursive: true });
    const root = mkdtempSync(path.join(temporary, 'paths-'));
    try {
      assert.notEqual(prepare(root).status, 0);
      const build = path.join(root, 'target/debug/build');
      mkdirSync(build, { recursive: true });
      // A junction is observable before any integrity label is changed.
      const outside = path.join(root, 'outside'); mkdirSync(outside);
      symlinkSync(outside, path.join(build, 'redirected'), 'junction');
      assert.notEqual(prepare(build).status, 0);
    } finally {
      assert.equal(path.dirname(root), path.resolve(temporary));
      rmSync(root, { recursive: true, force: true });
    }
  });

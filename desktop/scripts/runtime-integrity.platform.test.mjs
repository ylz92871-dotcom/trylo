import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const preparation = fileURLToPath(new URL('./prepare-runtime-integrity.ps1', import.meta.url));
test('a staged Low Node cannot write a normal directory; preparation restores its actual token and writes',
  { skip: process.platform !== 'win32' }, () => {
    const temp = path.join(checkout, 'Temp');
    mkdirSync(temp, { recursive: true });
    const runtime = mkdtempSync(path.join(temp, 'integrity-runtime-'));
    const destination = mkdtempSync(path.join(os.tmpdir(), 'trylo-medium-write-'));
    const node = path.join(runtime, 'node.exe');
    const output = path.join(destination, 'written.txt');
    try {
      copyFileSync(process.execPath, node);
      execFileSync('icacls.exe', [destination, '/setintegritylevel', '(OI)(CI)M'], { windowsHide: true });
      execFileSync('icacls.exe', [node, '/setintegritylevel', 'L'], { windowsHide: true });
      const program = `const fs=require('node:fs'),cp=require('node:child_process');
        const sid=cp.execFileSync('whoami.exe',['/groups','/fo','csv'],{encoding:'utf8',windowsHide:true}).match(/S-1-16-\\d+/)?.[0];
        let error=null;try{fs.writeFileSync(process.argv[1],'integrity-write-proof')}catch(e){error=e.code}
        process.stdout.write(JSON.stringify({sid,error}));`;
      const probe = () => JSON.parse(execFileSync(node, ['-e', program, output], { encoding: 'utf8', windowsHide: true }));
      const before = probe();
      assert.equal(before.sid, 'S-1-16-4096');
      assert.ok(['EPERM', 'EACCES'].includes(before.error));
      const prepared = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        preparation, '-RuntimeRoot', runtime], { encoding: 'utf8', windowsHide: true });
      assert.equal(prepared.status, 0, prepared.stderr);
      const after = probe();
      assert.ok(Number(after.sid.split('-').at(-1)) >= 8192);
      assert.equal(after.error, null);
      assert.equal(readFileSync(output, 'utf8'), 'integrity-write-proof');
      console.log(JSON.stringify({ lowWriteDenied: before.error, repairedToken: after.sid, realWrite: true }));
    } finally {
      rmSync(runtime, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  });

test('portable preparation restores a nested CLI helper, not only the four top-level executables',
  { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'trylo-portable-helper-'));
    const destination = mkdtempSync(path.join(os.tmpdir(), 'trylo-portable-effect-'));
    try {
      const launcher = path.join(root, 'Start-Trylo.ps1');
      copyFileSync(fileURLToPath(new URL('./Start-Trylo.ps1', import.meta.url)), launcher);
      writeFileSync(path.join(root, 'distribution.json'), JSON.stringify({ product: 'Trylo Desktop', distribution: 'core' }));
      for (const relative of ['trylo-desktop.exe', 'runtime/node/win-x64/node.exe',
        'sidecars/desktop-companion/publish/TryloDesktopPet.exe', 'desktop-services/wgc-helper/trylo-wgc-helper.exe']) {
        const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'fixture');
      }
      const helper = path.join(root, 'cli/dist/helpers/nested-helper.exe');
      mkdirSync(path.dirname(helper), { recursive: true }); copyFileSync(process.execPath, helper);
      execFileSync('icacls.exe', [helper, '/setintegritylevel', 'L'], { windowsHide: true });
      execFileSync('icacls.exe', [destination, '/setintegritylevel', '(OI)(CI)M'], { windowsHide: true });
      const prepared = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-PrepareOnly'], { encoding: 'utf8', windowsHide: true });
      assert.equal(prepared.status, 0, prepared.stderr);
      const effect = path.join(destination, 'effect.txt');
      const written = spawnSync(helper, ['-e', "require('node:fs').writeFileSync(process.argv[1],'nested helper works')", effect], { encoding: 'utf8', windowsHide: true });
      assert.equal(written.status, 0, written.stderr);
      assert.equal(readFileSync(effect, 'utf8'), 'nested helper works');
    } finally {
      rmSync(root, { recursive: true, force: true }); rmSync(destination, { recursive: true, force: true });
    }
  });

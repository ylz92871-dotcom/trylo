import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { buildPortableLauncher } from './build-portable-launcher.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const run = (file, args) => execFileSync(file, args, { windowsHide: true, encoding: 'utf8', timeout: 120_000 });
let evidence, launcher, probe;
before(() => {
  if (!windows) return;
  const destination = process.env.TRYLO_CONSOLE_EVIDENCE_DIR || path.join(root, 'Temp/portable-launcher');
  mkdirSync(destination, { recursive: true });
  evidence = mkdtempSync(path.join(destination, 'launcher-'));
  launcher = buildPortableLauncher(path.join(evidence, 'build'));
  probe = path.join(evidence, 'child.exe');
  run('rustc', ['--edition=2021', '-D', 'warnings', fileURLToPath(new URL('./fixtures/portable-child-probe.rs', import.meta.url)), '-o', probe]);
  console.log(`portable launcher evidence: ${evidence}`);
});

function fixture(name) {
  const directory = path.join(evidence, name);
  mkdirSync(directory);
  const entry = path.join(directory, 'Start-Trylo.exe');
  copyFileSync(launcher, entry);
  copyFileSync(probe, path.join(directory, 'trylo-desktop.exe'));
  copyFileSync(fileURLToPath(new URL('./Start-Trylo.ps1', import.meta.url)), path.join(directory, 'Start-Trylo.ps1'));
  writeFileSync(path.join(directory, 'distribution.json'), JSON.stringify({ product: 'Trylo Desktop', distribution: 'core' }));
  for (const relative of ['runtime/node/win-x64/node.exe', 'sidecars/desktop-companion/publish/TryloDesktopPet.exe',
    'desktop-services/wgc-helper/trylo-wgc-helper.exe', 'cli/dist/helpers/nested.exe']) {
    const file = path.join(directory, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    copyFileSync(probe, file);
  }
  run('icacls.exe', [entry, '/setintegritylevel', 'M']);
  return { directory, entry };
}

test('GUI launcher silently prepares a nested Low helper and preserves its real token and output', { skip: !windows }, () => {
  const f = fixture('路径有 空格');
  const helper = path.join(f.directory, 'cli/dist/helpers/nested.exe');
  run('icacls.exe', [helper, '/setintegritylevel', 'L']);
  const beforeReport = path.join(evidence, 'before-token.json');
  run(helper, [beforeReport]);
  assert.equal(JSON.parse(readFileSync(beforeReport)).integrityRid, 4096);
  const result = spawnSync(f.entry, ['--prepare-only'], { windowsHide: true, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, readFileSync(path.join(f.directory, 'Start-Trylo.log'), 'utf8'));
  assert.equal(existsSync(path.join(f.directory, 'desktop-started.json')), false);
  const afterReport = path.join(evidence, 'after-token.json');
  run(helper, [afterReport]);
  const after = JSON.parse(readFileSync(afterReport));
  assert.equal(after.console, false);
  assert.equal(after.visible, false);
  assert.ok(after.integrityRid >= 8192);
});

test('default GUI launcher starts its application after successful preparation without a console', { skip: !windows }, async () => {
  const f = fixture('normal');
  const result = spawnSync(f.entry, ['--no-error-dialog'], { windowsHide: true, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, readFileSync(path.join(f.directory, 'Start-Trylo.log'), 'utf8'));
  const report = path.join(f.directory, 'desktop-started.json');
  const deadline = Date.now() + 5000;
  while (!existsSync(report) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  const child = JSON.parse(readFileSync(report));
  assert.equal(child.console, false);
  assert.equal(child.visible, false);
  assert.ok(child.integrityRid >= 8192);
  assert.match(readFileSync(path.join(f.directory, 'Start-Trylo.log'), 'utf8'), /Desktop started, pid=/);
});

test('failed preparation returns failure, retains diagnostics, and cannot start the application', { skip: !windows }, () => {
  const f = fixture('invalid');
  writeFileSync(path.join(f.directory, 'distribution.json'), '{"product":"wrong","distribution":"core"}');
  const result = spawnSync(f.entry, ['--prepare-only'], { windowsHide: true, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 1);
  assert.equal(existsSync(path.join(f.directory, 'desktop-started.json')), false);
  const log = readFileSync(path.join(f.directory, 'Start-Trylo.log'), 'utf8');
  assert.match(log, /Invalid Trylo distribution/);
  assert.match(log, /Startup failed/);
});

test('a Low launcher reports its real authority and cannot promote its own token', { skip: !windows }, () => {
  const f = fixture('low-launcher');
  run('icacls.exe', [f.entry, '/setintegritylevel', 'L']);
  const result = spawnSync(f.entry, ['--prepare-only'], { windowsHide: true, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 1);
  assert.equal(existsSync(path.join(f.directory, 'desktop-started.json')), false);
  assert.match(readFileSync(path.join(f.directory, 'Start-Trylo.log'), 'utf8'), /running at Low integrity/);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadToFile } from '../../../desktop-services/src/tooling/tool-package-manager.mjs';
import { officeEngineDarwinLock as lock, officeEngineDigest, verifyMacosOfficeEngine } from './office-engine-darwin.mjs';

assert.equal(`${process.platform}-${process.arch}`, lock.platform, 'Run on Apple Silicon');
assert.ok(process.argv[2], 'Usage: node supply-office-engine.mjs <new office resource directory> [local DMG]');
const output = path.resolve(process.argv[2]);
const parent = path.dirname(output);
await fs.mkdir(parent, { recursive: true });
assert.equal(await fs.realpath(parent), parent, 'Office staging parent is redirected');
try {
  await fs.lstat(output);
  throw new Error(`Office staging output already exists: ${output}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const work = await fs.mkdtemp(path.join(parent, '.trylo-office-'));
let mounted = false;
try {
  const dmg = process.argv[3] ? path.resolve(process.argv[3]) : path.join(work, 'LibreOffice.dmg');
  if (!process.argv[3]) await downloadToFile(lock.sourceUrl, dmg, lock.packageBytes);
  assert.equal((await fs.stat(dmg)).size, lock.packageBytes, 'LibreOffice DMG size differs from the lock');
  assert.equal(await officeEngineDigest(dmg), lock.packageSha256, 'LibreOffice DMG SHA-256 differs from the lock');
  const mount = path.join(work, 'mount');
  const stage = path.join(work, 'office');
  await fs.mkdir(mount);
  await fs.mkdir(stage);
  execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { stdio: 'inherit' });
  mounted = true;
  try {
    await verifyMacosOfficeEngine(mount);
    const app = path.join(mount, lock.bundle);
    const stagedApp = path.join(stage, lock.bundle);
    // Upstream signs the resource tree. Retain its structure and embedded notices.
    execFileSync('/usr/bin/ditto', [app, stagedApp], { stdio: 'inherit' });
    await verifyMacosOfficeEngine(stage);
  } finally {
    execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'inherit' });
    mounted = false;
  }
  await fs.rename(stage, output);
  console.log(`LibreOffice ${lock.version} staged at ${output}`);
} finally {
  if (!mounted) await fs.rm(work, { recursive: true, force: true });
}

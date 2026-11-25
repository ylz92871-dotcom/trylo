import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(desktop, 'scripts/prepare-sidecars.ps1')],
    { cwd: desktop, stdio: 'inherit' });
} else {
  assert.equal(`${process.platform}-${process.arch}`, 'darwin-arm64', 'No release sidecar supply for this platform');
  const tauri = path.join(desktop, 'src-tauri');
  assert.equal(await fs.realpath(tauri), tauri, 'Tauri staging directory is redirected');
  const resources = path.join(tauri, 'resources');
  const current = await fs.lstat(resources).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert.ok(!current || current.isDirectory(), 'Refuse to replace a redirected resources path');
  const root = path.resolve(desktop, '../_workspace/artifacts/local-release');
  await fs.mkdir(root, { recursive: true });
  assert.equal(await fs.realpath(root), root, 'Release artifacts directory is redirected');
  const work = await fs.mkdtemp(path.join(root, 'macos-sidecars-'));
  const candidate = path.join(work, 'candidate-resources');
  const backup = path.join(work, 'previous-resources');
  execFileSync(process.execPath, [path.join(desktop, 'scripts/prepare-macos-sidecars.mjs'), candidate, '--preview'],
    { cwd: desktop, stdio: 'inherit' });
  if (current) await fs.rename(resources, backup);
  try {
    await fs.rename(candidate, resources);
  } catch (error) {
    if (current) await fs.rename(backup, resources);
    throw error;
  }
  if (current) console.log(`Previous staging resources retained at ${backup}`);
}

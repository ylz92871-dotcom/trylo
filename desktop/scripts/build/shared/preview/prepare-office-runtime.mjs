// Normalize only verified Office executable copies before Windows dev launch.
// Tauri copies bytes into a checkout that may have a Low mandatory label.
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyOfficeRuntime } from './office-engine.mjs';
const execute = promisify(execFile);
const checkout = await realpath(fileURLToPath(new URL('../../../../../', import.meta.url)));
export async function prepareOfficeRuntime(engineRoot) {
  if (process.platform !== 'win32') return { skipped: 'not Windows' };
  const root = await realpath(engineRoot);
  const relativeRoot = path.relative(checkout, root);
  if (!relativeRoot || relativeRoot === '..' || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot)) throw new Error('Office dev runtime must stay inside this checkout');
  await verifyOfficeRuntime(root); // Pinned runtime inventory and critical binaries.
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const executables = [];
  for (const entry of manifest.files) {
    if (!/\.(exe|com|bin)$/i.test(entry.path)) continue;
    const target = await realpath(path.join(root, entry.path));
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Office executable escaped its verified resource root');
    if ((await stat(target)).nlink > 1) throw new Error(`Refuse shared hard-linked Office executable: ${entry.path}`);
    const hash = createHash('sha256'); let head;
    for await (const chunk of createReadStream(target)) { head ??= chunk.subarray(0, 2); hash.update(chunk); }
    if (hash.digest('hex') !== entry.sha256) throw new Error(`Office executable checksum failed: ${entry.path}`);
    if (head?.[0] === 77 && head?.[1] === 90) executables.push({ path: entry.path, target, sha256: entry.sha256 });
  }
  // Validate every selected byte before changing any label. No recursive ACL
  // or DACL mutation; a normal Medium process must initialize private profiles.
  for (const entry of executables) await execute('icacls.exe', [entry.target, '/setintegritylevel', 'M'], { windowsHide: true, timeout: 10000, maxBuffer: 32768 });
  return { root, executableCount: executables.length, integrity: 'M', executables: executables.map(({ path, sha256 }) => ({ path, sha256 })) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--root');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Expected --root <verified checkout Office resource directory>');
  console.log(JSON.stringify(await prepareOfficeRuntime(process.argv[index + 1]), null, 2));
}

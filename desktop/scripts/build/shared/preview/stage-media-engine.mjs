// Copies only pinned console programs, shared libraries and original notices.
// Never invokes FFmpeg/ffplay, downloads on app startup, or searches PATH.
import { copyFile, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mediaEngineLock as lock, mediaEngineRoot as destination, verifyMediaEngine } from './media-engine.mjs';
if (!process.argv.includes('--check')) {
  const argument = process.argv.indexOf('--from');
  if (argument < 0 || !process.argv[argument + 1]) throw new Error('Provide --from <verified extracted LGPL shared distribution>');
  const source = await realpath(process.argv[argument + 1]);
  await verifyMediaEngine(source);
  await mkdir(path.dirname(destination), { recursive: true });
  if ((await realpath(path.dirname(destination))).toLowerCase() !== path.dirname(destination).toLowerCase()) throw new Error('Redirected media resources directory');
  if (await stat(destination).catch(() => false)) {
    await verifyMediaEngine(destination);
  } else {
    await mkdir(destination);
    for (const entry of lock.files) {
      const target = path.join(destination, entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(source, entry.path), target, 1);
    }
    await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
  }
}
await verifyMediaEngine(destination);
const allowed = new Set([...lock.files.map((entry) => entry.path), 'manifest.json']);
async function check(directory = '') {
  for (const entry of await readdir(path.join(destination, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Redirected media resource ${relative}`);
    if (entry.isDirectory()) await check(relative);
    else if (!entry.isFile() || !allowed.has(relative)) throw new Error(`Unexpected media resource ${relative}`);
  }
}
await check();
console.log(`Media engine verified: ${lock.version}, ${lock.files.length} pinned files; ffplay excluded`);

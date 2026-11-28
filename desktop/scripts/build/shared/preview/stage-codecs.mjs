import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewFormatFiles } from './codec-files.mjs';
import { verifyArchiveRelease } from './verify-archive-engine.mjs';
const archiveSupply = await verifyArchiveRelease();
const desktop = fileURLToPath(new URL('../../../../', import.meta.url));
const root = path.resolve(process.env.TRYLO_RESOURCE_DIR ?? path.join(desktop, 'src-tauri/resources'), 'preview/codecs');
await mkdir(root, { recursive: true });
if ((await realpath(root)).toLowerCase() !== root.toLowerCase()) throw new Error('Redirected codec resources');
const files = [];
const packageFiles = previewFormatFiles();
const pakoPackage = JSON.parse(await readFile(path.resolve(path.dirname(packageFiles.get('preview-codecs/tiff/pako.min.js')), '../package.json'), 'utf8'));
async function replace(file, bytes) {
  const prior = await lstat(file).catch(() => undefined);
  if (prior?.isSymbolicLink() || (prior && !prior.isFile())) throw new Error('Redirected codec resource file');
  if (prior && (await readFile(file)).equals(Buffer.from(bytes))) return;
  const temporary = `${file}.staging-${process.pid}`;
  await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, file);
}
for (const [name, source] of packageFiles) {
  if (!name.startsWith('preview-codecs/')) continue;
  const relative = name.slice('preview-codecs/'.length), target = path.join(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error('Invalid codec resource path');
  await mkdir(path.dirname(target), { recursive: true });
  if ((await realpath(path.dirname(target))).toLowerCase() !== path.dirname(target).toLowerCase()) throw new Error('Redirected codec resource subdirectory');
  const bytes = await readFile(source); await replace(target, bytes);
  files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await replace(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, providers: { utif: '3.1.0', pako: pakoPackage.version, libheifJs: '1.23.5', occtImportJs: '0.0.23', archive: archiveSupply.lock.version }, files }, null, 2));
console.log(`External preview codecs staged: ${files.length} unmodified provider and notice files`);

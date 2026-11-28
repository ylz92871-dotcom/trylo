import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadToFile } from '../../../../../desktop-services/src/tooling/tool-package-manager.mjs';
import { mediaFileDigest } from './media-engine.mjs';

assert.ok(process.argv[2], 'Usage: node fetch-macos-engine-sources.mjs <source bundle directory>');
const output = path.resolve(process.argv[2]);
const readLock = async name => JSON.parse(await fs.readFile(new URL(name, import.meta.url), 'utf8'));
const media = await readLock('./media-sources.lock.json');
const archive = await readLock('./archive-engine.lock.json');
const mediaSources = media.files.filter(file => ['ffmpeg-source.tar.gz', 'hls-js-source.tar.gz'].includes(file.name));

async function fetchInventory(directory, inventoryName, identity, files) {
  const root = path.join(output, directory);
  await fs.mkdir(root, { recursive: true });
  assert.equal(await fs.realpath(root), root, 'Source output is redirected');
  for (const { name, url, bytes, sha256 } of files) {
    const dest = path.join(root, name);
    const scratch = `${dest}.partial-${process.pid}`;
    const current = await fs.lstat(dest).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    try {
      if (!current) await downloadToFile(url, scratch, bytes);
      const file = current ? dest : scratch;
      const stat = current ?? await fs.lstat(file);
      assert.ok(stat.isFile() && stat.size === bytes && await mediaFileDigest(file) === sha256, `Pinned source mismatch: ${name}`);
      if (!current) await fs.rename(scratch, dest);
    } finally {
      await fs.rm(scratch, { force: true });
    }
  }
  await fs.writeFile(path.join(root, inventoryName), JSON.stringify({ schemaVersion: 1, ...identity, files, errors: [] }, null, 2) + '\n');
  console.log(`${directory}: ${files.length} verified source archives`);
}

await Promise.all([
  fetchInventory('media-sources', 'media-source-inventory.json', { engineVersion: media.engineVersion }, mediaSources),
  fetchInventory('archive-sources', 'archive-source-inventory.json', { version: archive.version }, archive.sources),
]);

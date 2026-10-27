import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.argv[3] ? path.resolve(process.argv[3]) : path.join(repo, 'output/amd-dual-pool-desktop-20261025');
if (!output.startsWith(path.join(repo, 'output') + path.sep)) throw Error('Stage evidence must remain under workspace output');
const label = process.argv[2] || ''; if (label && !/^[a-z-]+$/.test(label)) throw Error('Invalid stage evidence label');
const staged = path.join(output, 'service-host/host.bundle.mjs');
const targets = [path.join(repo, 'desktop-services/dist/host.bundle.mjs'), path.join(repo, 'desktop/src-tauri/resources/desktop-services/dist/host.bundle.mjs')];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(path.dirname(staged), { recursive: true });
const originals = await Promise.all(targets.map(async filename => { try { return await fs.readFile(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } }));
await build({ entryPoints: [path.join(repo, 'desktop-services/src/host.mjs')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);" }, outfile: staged });
const bytes = await fs.readFile(staged);
for (let i = 0; i < targets.length; i++) {
  const current = await fs.readFile(targets[i]).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (hash(current || Buffer.alloc(0)) !== hash(originals[i] || Buffer.alloc(0))) throw Error('Concurrent Service Host update; refusing to overwrite');
  if (originals[i]) await fs.writeFile(path.join(output, 'before', `host-bundle-${i}${label ? '-' + label : ''}.mjs`), originals[i], { flag: 'wx' });
  await fs.mkdir(path.dirname(targets[i]), { recursive: true });
  const temporary = targets[i] + '.platform.tmp'; await fs.writeFile(temporary, bytes); await fs.rename(temporary, targets[i]);
}
await fs.writeFile(path.join(output, 'service-host-stage.json'), JSON.stringify({ sha256: hash(bytes), size: bytes.length, targets, previousHashes: originals.map(value => value && hash(value)) }, null, 2) + '\n');
console.log(JSON.stringify({ staged: true, sha256: hash(bytes), size: bytes.length }));

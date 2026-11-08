import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Download-only source companion. No archive is extracted or executed.
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../..');
const index = process.argv.indexOf('--output');
if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: node scripts/preview/fetch-sources.mjs --output <checkout directory>');
const output = path.resolve(process.argv[index + 1]);
if (!output.startsWith(repository + path.sep)) throw new Error('Source output must be inside this checkout');
await mkdir(output, { recursive: true });
if ((await realpath(output)).toLowerCase() !== output.toLowerCase()) throw new Error('Redirected source output directory');
const office = JSON.parse(await readFile(path.join(here, 'office-engine.lock.json'), 'utf8'));
const sourceLock = JSON.parse(await readFile(path.join(here, 'source-archives.lock.json'), 'utf8'));
if (sourceLock.schemaVersion !== 1 || sourceLock.officeVersion !== office.version) throw new Error('Update the matching source archive lock before upgrading Office');
const desktopPackage = JSON.parse(await readFile(path.resolve(here, '../../package.json'), 'utf8'));
for (const [name, version] of [['libheif-js', '1.23.5'], ['occt-import-js', '0.0.23'], ['utif', '3.1.0']]) {
  if (desktopPackage.dependencies[name] !== version) throw new Error(`Update the source supply pins before releasing ${name}`);
}
const sourceVersion = office.version;
const specs = [
  ...['libreoffice', 'libreoffice-dictionaries', 'libreoffice-help', 'libreoffice-translations'].map((name) => ({ name: `${name}-${sourceVersion}.tar.xz`, url: `${office.sourceCodeUrl}${name}-${sourceVersion}.tar.xz`, officialChecksum: true })),
  { name: 'libheif-js-source.tar.gz', url: 'https://api.github.com/repos/catdad-experiments/libheif-js/tarball/d8ec4bc3bc5bf8055975577bccbbc7e1d7313c2d' },
  { name: 'libheif-emscripten-source.tar.gz', url: 'https://api.github.com/repos/catdad-experiments/libheif-emscripten/tarball/v1.23.5' },
  { name: 'libheif-source.tar.gz', url: 'https://api.github.com/repos/strukturag/libheif/tarball/413e2a87e6a70b3eccc3a3adc5801179dd2d9e00' },
  { name: 'libde265-source.tar.gz', url: 'https://api.github.com/repos/strukturag/libde265/tarball/v1.0.15' },
  { name: 'occt-import-js-source.tar.gz', url: 'https://api.github.com/repos/kovacsv/occt-import-js/tarball/c2148e54b456b571238d35cac037d304053d64b2' },
  { name: 'occt-source.tar.gz', url: 'https://api.github.com/repos/Open-Cascade-SAS/OCCT/tarball/d2abb6d844231cb8f29be6894440874a4700e4a5' },
];
const headers = { 'User-Agent': 'Trylo-Preview-Source-Supply', Accept: 'application/vnd.github+json' };
const records = [];
async function digest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function acquire(spec) {
  const provenancePath = path.join(output, `${spec.name}.json`), target = path.join(output, spec.name);
  const pinned = sourceLock.files.find((file) => file.name === spec.name);
  if (!pinned || pinned.url !== spec.url) throw new Error(`Source archive is not pinned: ${spec.name}`);
  const expected = pinned.sha256;
  let mirrors = [];
  if (spec.officialChecksum) {
    const metadata = await fetch(`${spec.url}.mirrorlist`, { signal: AbortSignal.timeout(30_000) });
    if (!metadata.ok) throw new Error(`Official checksum HTTP ${metadata.status}: ${spec.name}`);
    const details = await metadata.text(); await writeFile(path.join(output, `${spec.name}.mirrorlist.html`), details);
    const official = details.match(/SHA-?256[\s\S]*?<tt>([a-f0-9]{64})<\/tt>/i)?.[1]?.toLowerCase();
    if (official !== expected) throw new Error(`Official SHA256 differs from the source lock: ${spec.name}`);
    mirrors = [...details.matchAll(/href="(https:[^"]+\.tar\.xz)"/g)].map((match) => match[1]);
    mirrors.sort((a, b) => Number(b.includes('mirrors.nju.edu.cn')) - Number(a.includes('mirrors.nju.edu.cn')));
  }
  if (await stat(target).catch(() => false)) {
    const prior = JSON.parse(await readFile(provenancePath, 'utf8'));
    if (prior.url !== spec.url || prior.sha256 !== await digest(target) || prior.sha256 !== expected || (await stat(target)).size !== pinned.bytes) throw new Error(`Retain and inspect prior source mismatch: ${spec.name}`);
    records.push(prior); console.log(`Verified cached source: ${spec.name}`); return;
  }
  let response;
  for (const candidate of [...mirrors.slice(0, 2), spec.url]) {
    try {
      const attempt = await fetch(candidate, { headers, signal: AbortSignal.timeout(10 * 60_000) });
      if (attempt.ok && attempt.body) { response = attempt; break; }
      await attempt.body?.cancel(); console.log(`Source HTTP ${attempt.status}: ${spec.name}`);
    } catch (error) { console.log(`Source request failed: ${spec.name}: ${String(error)}`); }
  }
  if (!response) throw new Error(`No source supplied: ${spec.name}`);
  const hash = createHash('sha256'); let bytes = 0, lastReport = Date.now();
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length; if (bytes > 600 * 1024 * 1024) { callback(new Error(`Source archive exceeds limit: ${spec.name}`)); return; }
    hash.update(chunk); if (Date.now() - lastReport > 15_000) { console.log(`Source ${spec.name}: ${Math.round(bytes / 1048576)} MB`); lastReport = Date.now(); } callback(null, chunk);
  } });
  const temporary = `${target}.partial-${process.pid}`;
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'wx' }));
  const sha256 = hash.digest('hex'); if (sha256 !== expected || bytes !== pinned.bytes) throw new Error(`Pinned source digest/size mismatch: ${spec.name}`);
  const record = { name: spec.name, url: spec.url, resolvedUrl: response.url, sha256, ...(spec.officialChecksum ? { officialSha256: expected } : {}), bytes };
  await rename(temporary, target); await writeFile(provenancePath, JSON.stringify(record, null, 2)); records.push(record);
  console.log(`Source ready: ${spec.name}, ${bytes} bytes`);
}
let next = 0; const errors = [];
await Promise.all(Array.from({ length: 2 }, async () => { while (next < specs.length) { const spec = specs[next++]; try { await acquire(spec); } catch (error) { errors.push({ name: spec.name, error: String(error) }); console.error(String(error)); } } }));
await writeFile(path.join(output, 'source-inventory.json'), JSON.stringify({ schemaVersion: 1, officeVersion: sourceVersion, files: records.sort((a, b) => a.name.localeCompare(b.name)), errors }, null, 2));
if (errors.length) process.exitCode = 1;

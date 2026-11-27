import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(path.join(here, 'office-engine.lock.json'), 'utf8'));
const repository = path.resolve(here, '../../../../..');
const index = process.argv.indexOf('--output');
if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: download-office-engine.mjs --output <checkout cache directory>');
const output = path.resolve(process.argv[index + 1]);
if (!output.startsWith(repository + path.sep)) throw new Error('Engine cache must be inside the checkout');
await mkdir(output, { recursive: true });
if ((await realpath(output)).toLowerCase() !== output.toLowerCase()) throw new Error('Redirected engine cache');
const target = path.join(output, path.basename(new URL(lock.sourceUrl).pathname));
async function digest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
function verifyPublisher() {
  if (process.platform !== 'win32') throw new Error('The pinned engine supply is Windows x64');
  const env = { ...process.env, TRYLO_ENGINE_SIGNATURE_FILE: target }; delete env.PSModulePath;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$s=Get-AuthenticodeSignature -LiteralPath $env:TRYLO_ENGINE_SIGNATURE_FILE; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=The Document Foundation') { throw 'Office publisher signature is invalid' }"], { env, windowsHide: true, stdio: 'pipe' });
}
if (await stat(target).catch(() => undefined)) {
  if (await digest(target) !== lock.packageSha256) throw new Error('Retain and inspect the cached MSI digest mismatch');
  verifyPublisher(); console.log(`Pinned official MSI already verified: ${target}`); process.exit(0);
}
const metadata = await fetch(`${lock.sourceUrl}.mirrorlist`, { signal: AbortSignal.timeout(30_000) });
if (!metadata.ok) throw new Error(`Official mirror metadata HTTP ${metadata.status}`);
const details = await metadata.text(); await writeFile(path.join(output, 'mirrorlist.html'), details);
const expected = details.match(/SHA-?256[\s\S]*?<tt>([a-f0-9]{64})<\/tt>/i)?.[1]?.toLowerCase();
if (expected !== lock.packageSha256) throw new Error('Official package checksum no longer matches the release lock');
const mirrors = [...details.matchAll(/href="(https:[^"]+\.msi)"/g)].map((match) => match[1]);
let response;
for (const candidate of [lock.sourceUrl, ...mirrors.slice(0, 3)]) {
  try {
    const attempt = await fetch(candidate, { signal: AbortSignal.timeout(10 * 60_000) });
    if (attempt.ok && attempt.body) { response = attempt; break; }
    await attempt.body?.cancel(); console.log(`Official listed mirror HTTP ${attempt.status}`);
  } catch (error) { console.log(`Official listed mirror failed: ${String(error)}`); }
}
if (!response) throw new Error('No official listed mirror supplied the pinned engine');
const hash = createHash('sha256'); let bytes = 0, lastReport = Date.now();
const meter = new Transform({ transform(chunk, _encoding, callback) {
  bytes += chunk.length; if (bytes > 800 * 1024 * 1024) { callback(new Error('Engine MSI exceeds supply limit')); return; }
  hash.update(chunk); if (Date.now() - lastReport > 15_000) { console.log(`Office engine download: ${Math.round(bytes / 1048576)} MB`); lastReport = Date.now(); } callback(null, chunk);
} });
const temporary = `${target}.partial-${process.pid}`;
await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'wx' }));
const sha256 = hash.digest('hex'); if (sha256 !== lock.packageSha256) throw new Error('Engine MSI digest mismatch');
await rename(temporary, target); verifyPublisher();
await writeFile(path.join(output, 'provenance.json'), JSON.stringify({ version: lock.version, url: lock.sourceUrl, resolvedUrl: response.url, sha256, bytes, downloadedAt: new Date().toISOString() }, null, 2));
console.log(`Official engine MSI verified: ${lock.version}, ${bytes} bytes`);

// Explicit preparation for existing, pinned CLI build inputs.
// npm run build remains offline and never downloads or weakens its hash checks.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'new trylo cli');
const provenance = JSON.parse(readFileSync(path.join(cli, 'src/internal/adapters/sandbox/vendor/sandbox-runtime/PROVENANCE.json'), 'utf8'));
const pty = JSON.parse(readFileSync(path.join(cli, 'vendor-bin/pty/PROVENANCE.json'), 'utf8'));
const url = 'https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-0.0.73.tgz';
const integrity = 'F608iUirrCqwvInZYGRRgJWDQj0tt6fNVE9aPagpotLJ5LhC4JbrMFIIZww5MFjb+HRCkpE0+xdI79c30tdVYg==';
const cap = 20 * 1024 * 1024;
const hash = (data, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(data).digest(encoding);
const helpers = ['x64', 'arm64'].map(arch => ({
  relative: `vendor-bin/srt-win-${arch}.exe`,
  member: `package/vendor/srt-win/${arch}/srt-win.exe`,
  ...provenance.artifacts[`srt-win-${arch}`],
}));
const args = process.argv.slice(2);
if (!(args.length === 1 && ['--check', '--install'].includes(args[0])) && !(args.length === 2 && args[0] === '--archive')) {
  console.error('Usage: node scripts/setup-cli-native.mjs --check|--install|--archive <pinned.tgz>');
  process.exit(2);
}
if (provenance.upstream !== '@anthropic-ai/sandbox-runtime' || provenance.version !== '0.0.73') throw new Error('Sandbox provenance changed; review the download pin first.');

function checkedPath(relative) {
  const dest = path.resolve(cli, relative);
  if (!dest.startsWith(cli + path.sep)) throw new Error('Native input escapes CLI root');
  for (let at = dest; at !== cli; at = path.dirname(at)) {
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new Error(`Redirected native input: ${relative}`);
  }
  return dest;
}
function valid(data, expected) {
  return data.length === expected.bytes && hash(data) === expected.sha256;
}
function present(entry) {
  const dest = checkedPath(entry.relative);
  if (!existsSync(dest)) return false;
  if (!valid(readFileSync(dest), entry)) throw new Error(`Native input differs from provenance: ${entry.relative}; preserve and investigate it before replacing.`);
  return true;
}
if (process.platform === 'darwin' && process.arch === 'arm64') {
  const native = pty.artifacts['trylo-pty-darwin-arm64'];
  if (!native || !present({ relative: native.path, ...native })) throw new Error('Missing tracked Apple Silicon PTY helper');
  accessSync(checkedPath(native.path), constants.X_OK);
  if (args[0] === '--archive') throw new Error('The npm sandbox archive is for Windows. The macOS CLI uses system Seatbelt.');
  console.log(`OK ${native.path}`);
  process.exit(0);
}
const ptyEntry = pty.artifacts['trylo-pty-win-x64'];
if (!ptyEntry || !present({ relative: ptyEntry.path, ...ptyEntry })) throw new Error('Missing tracked Windows x64 PTY helper. Pull the complete source checkout; see docs/development/build-from-source.md.');
const missing = helpers.filter(entry => !present(entry));
if (args[0] === '--check') {
  for (const entry of helpers) console.log(`${missing.includes(entry) ? 'MISSING' : 'OK'} ${entry.relative}`);
  console.log(`OK ${ptyEntry.path}`);
  process.exitCode = missing.length ? 1 : 0;
} else if (missing.length === 0) {
  console.log('All CLI native inputs already match provenance; no download.');
} else {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The npm sandbox archive is only used by the Windows x64 build.');
  let archive;
  if (args[0] === '--archive') {
    const file = path.resolve(args[1]);
    if (lstatSync(file).size > cap) throw new Error('Archive exceeds byte cap');
    archive = readFileSync(file);
  } else {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error(`Pinned sandbox download failed: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > cap) throw new Error('Archive exceeds byte cap');
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    archive = Buffer.concat(chunks);
  }
  if (hash(archive, 'sha512', 'base64') !== integrity) throw new Error('Pinned npm archive integrity mismatch');
  // Extract only named files from the verified archive into disposable staging.
  const vendor = checkedPath('vendor-bin');
  mkdirSync(vendor, { recursive: true });
  const temp = mkdtempSync(path.join(vendor, 'sandbox-stage-'));
  try {
    const tgz = path.join(temp, 'sandbox.tgz');
    writeFileSync(tgz, archive, { flag: 'wx' });
    execFileSync('tar', ['-xzf', tgz, '-C', temp, ...helpers.map(entry => entry.member)], { stdio: 'pipe', timeout: 30_000 });
    const binaries = helpers.map(entry => readFileSync(path.join(temp, entry.member)));
    for (let i = 0; i < helpers.length; i++) if (!valid(binaries[i], helpers[i])) throw new Error(`Extracted helper differs from provenance: ${helpers[i].relative}`);
    for (const entry of missing) {
      const dest = checkedPath(entry.relative);
      if (existsSync(dest)) throw new Error(`Native input appeared during preparation: ${entry.relative}`);
      renameSync(path.join(temp, entry.member), dest);
      console.log(`INSTALLED ${entry.relative} (SHA-256 and size verified)`);
    }
  } finally {
    if (!path.resolve(temp).startsWith(path.resolve(vendor) + path.sep)) throw new Error('Staging cleanup escapes vendor directory');
    rmSync(temp, { recursive: true, force: true });
  }
}

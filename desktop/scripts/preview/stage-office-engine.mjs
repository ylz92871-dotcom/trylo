import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(path.join(here, 'office-engine.lock.json'), 'utf8'));
const desktop = path.resolve(here, '../..');
const destination = path.join(desktop, 'src-tauri/resources/preview/office');

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function inventory(root, directory = '', files = [], skipInstaller = false) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    // Administrative extraction retains its input MSI at the root; it is
    // a supply artifact, not a runtime file. Copy every other original file.
    if (skipInstaller && !directory && entry.isFile() && /\.msi$/i.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Redirected engine entry: ${relative}`);
    if (entry.isDirectory()) await inventory(root, relative, files, skipInstaller);
    else if (entry.isFile()) {
      if (relative === 'manifest.json') continue;
      files.push({ path: relative, size: (await stat(path.join(root, relative))).size, sha256: await digest(path.join(root, relative)) });
    } else throw new Error(`Non-regular engine entry: ${relative}`);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function validate(files) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const [name, hash] of Object.entries(lock.criticalFiles)) {
    if (byPath.get(name)?.sha256 !== hash) throw new Error(`Pinned Office engine mismatch: ${name}`);
  }
  for (const name of ['license.txt', 'LICENSE.html', 'NOTICE', 'program/services.rdb', 'program/fundamental.ini']) {
    if (!byPath.has(name)) throw new Error(`Incomplete Office distribution: ${name}`);
  }
  if (!files.some((file) => file.path.startsWith('share/registry/'))) throw new Error('Missing Office filter registry');
  const identity = createHash('sha256').update(canonicalFiles(files)).digest('hex');
  if (identity !== lock.distributionFilesSha256) throw new Error('Full Office payload does not match the official release inventory');
}
function canonicalFiles(files) {
  return JSON.stringify([...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))));
}
async function check(root) {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.provider !== lock.provider || manifest.version !== lock.version || manifest.buildId !== lock.buildId) throw new Error('Engine manifest does not match the release lock');
  const files = await inventory(root);
  validate(files);
  if (canonicalFiles(files) !== canonicalFiles(manifest.files)) throw new Error('Office distribution inventory mismatch');
  return manifest;
}

if (process.argv.includes('--check')) {
  const manifest = await check(destination);
  console.log(`Office engine verified: ${manifest.version}, ${manifest.files.length} files`);
} else {
  const resources = path.dirname(destination);
  await mkdir(resources, { recursive: true });
  // All mutation targets are resolved under this checkout. Reject a junction
  // redirecting the resource directory before copying or renaming anything.
  if ((await realpath(resources)).toLowerCase() !== resources.toLowerCase()) throw new Error('Redirected preview resources directory');
  try {
    const existing = await check(destination);
    console.log(`Office engine already staged: ${existing.version}, ${existing.files.length} files`);
    process.exit(0);
  } catch (error) {
    try { await stat(destination); } catch { /* no prior stage */ }
    if (await stat(destination).catch(() => null)) throw new Error(`Existing engine is invalid; preserve and inspect it before restaging: ${error.message}`);
  }
  const sourceArgument = process.argv.indexOf('--source');
  const source = await realpath(sourceArgument >= 0 ? process.argv[sourceArgument + 1] : process.env.TRYLO_OFFICE_ENGINE_DIR ?? path.join(process.env.ProgramW6432 ?? process.env.ProgramFiles ?? '', 'LibreOffice'));
  if (source.toLowerCase().startsWith(resources.toLowerCase())) throw new Error('Engine source must be independent of staged resources');
  const files = await inventory(source, '', [], true);
  validate(files);
  const version = await readFile(path.join(source, 'program/version.ini'), 'utf8');
  if (!version.includes(`buildid=${lock.buildId}`)) throw new Error('Office build identity mismatch');
  if (process.platform === 'win32') {
    // Pass the path through the process environment, never interpolate it into
    // PowerShell source. Checking Authenticode does not modify the installation.
    const signatureEnvironment = { ...process.env, TRYLO_ENGINE_SIGNATURE_FILE: path.join(source, 'program/soffice.exe') };
    // A PowerShell 7 parent exports its own module path. Windows PowerShell
    // must initialize its matching system modules instead of loading PS7 ones.
    delete signatureEnvironment.PSModulePath;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$s=Get-AuthenticodeSignature -LiteralPath $env:TRYLO_ENGINE_SIGNATURE_FILE; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=The Document Foundation') { throw 'Office publisher signature is invalid' }"], {
      windowsHide: true, env: signatureEnvironment, stdio: 'pipe',
    });
  }
  const staging = `${destination}.staging-${process.pid}`;
  if (!staging.startsWith(`${resources}${path.sep}`)) throw new Error('Staging path escaped resources');
  await cp(source, staging, { recursive: true, errorOnExist: true, force: false, dereference: false,
    filter: (file) => path.dirname(file) !== source || !/\.msi$/i.test(file),
  });
  await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, ...lock, entry: 'program/soffice.com', files }, null, 2)}\n`);
  await check(staging);
  await rename(staging, destination);
  console.log(`Office engine staged: ${lock.version}, ${files.length} files, ${files.reduce((sum, file) => sum + file.size, 0)} bytes`);
}

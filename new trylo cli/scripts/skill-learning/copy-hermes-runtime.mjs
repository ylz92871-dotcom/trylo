// Stage the skill subsystem's non-TypeScript runtime closure. Never clean dist.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SKILL_RUNTIME_REL = 'internal/learning/agent/subsystems/skill';
const EXCLUDED_DIRECTORIES = new Set(['test', 'tests', '__tests__', '__pycache__', '.pytest_cache', 'node_modules']);
const RUNTIME_EXTENSIONS = new Set(['.mjs', '.cjs', '.json', '.js', '.py']);

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function relative(root, file) { return path.relative(root, file).replaceAll('\\', '/'); }

function inside(root, file) {
  const suffix = path.relative(root, file);
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${path.sep}`) && !path.isAbsolute(suffix);
}

function runtimeFile(name) {
  if (/\.(?:test|spec)\./i.test(name) || /^(?:test_.*|.*_test)\.py$/i.test(name)) return false;

  if (RUNTIME_EXTENSIONS.has(path.extname(name).toLowerCase())) return true;

  return /(?:^|[-_.])(?:LICENSE|LICENCE|NOTICE)(?:[-_.]|$)/i.test(name)
    || /^PROVENANCE(?:[._-].*)?$/i.test(name)
    || /^PINNED[_-]VERSIONS(?:\..*)?$/i.test(name)
    || /^requirements(?:[._-].*)?$/i.test(name)
    || /^README\.upstream\.md$/i.test(name);
}

function captureRuntime(sourceRoot) {
  const files = [];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);

      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue;

      if (entry.isSymbolicLink()) throw new Error(`copy-hermes: source link requires review: ${file}`);

      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && runtimeFile(entry.name)) {
        const bytes = readFileSync(file);
        files.push({ path: relative(sourceRoot, file), bytes, sha256: sha(bytes) });
      }
    }
  }

  walk(sourceRoot);

  return files;
}

function verifyVendorManifest(files) {
  const byPath = new Map(files.map(row => [row.path, row]));

  for (const required of ['compat/index.mjs', 'host/worker.mjs', 'vendor/VENDOR-MANIFEST.json', 'vendor/legacy/package.json']) {
    if (!byPath.has(required)) throw new Error(`copy-hermes: required runtime file is missing: ${required}`);
  }

  const manifest = JSON.parse(byPath.get('vendor/VENDOR-MANIFEST.json').bytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) throw new Error('copy-hermes: invalid vendor manifest');

  for (const asset of manifest.assets) {
    if (!asset || typeof asset.destination !== 'string' || typeof asset.vendoredSha256 !== 'string' || !Number.isSafeInteger(asset.bytes)) {
      throw new Error('copy-hermes: invalid vendor manifest asset');
    }

    const staged = byPath.get(`vendor/${asset.destination}`);
    if (!staged || staged.bytes.length !== asset.bytes || staged.sha256 !== asset.vendoredSha256) {
      throw new Error(`copy-hermes: vendor manifest does not match staged closure: ${asset.destination}`);
    }
  }

  return manifest.assets.length;
}

function rejectRedirectedOutput(outRoot, destination) {
  for (let current = destination; ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`copy-hermes: output link requires review: ${current}`);
    if (current === outRoot) break;
    if (!inside(outRoot, current)) throw new Error('copy-hermes: destination escapes output root');
  }
}

/** Capture and verify the authoritative non-TS runtime without writing output.
 * Build staging and development readiness share this exact eligibility policy.
 * Returned paths are relative to sourceRoot; bytes/hash describe this capture. */
export function readSkillRuntimeClosure({ sourceRoot = path.join(packageRoot, 'src', SKILL_RUNTIME_REL) } = {}) {
  const source = path.resolve(sourceRoot);
  if (lstatSync(source).isSymbolicLink()) throw new Error('copy-hermes: source root link requires review');
  const files = captureRuntime(source);
  return { sourceRoot: source, files, vendorAssetsVerified: verifyVendorManifest(files) };
}

/** outRoot is a dist root; sourceRoot may be a frozen copy of the skill subtree. */
export function copyHermesRuntime({ outRoot = path.join(packageRoot, 'dist'), sourceRoot = path.join(packageRoot, 'src', SKILL_RUNTIME_REL) } = {}) {
  const source = path.resolve(sourceRoot), output = path.resolve(outRoot);
  const target = path.join(output, SKILL_RUNTIME_REL);
  if (output === source || inside(source, output) || source === target || inside(target, source)) throw new Error('copy-hermes: output overlaps source input');

  const { files: captured, vendorAssetsVerified } = readSkillRuntimeClosure({ sourceRoot: source });
  const files = [];

  for (const row of captured) {
    const destination = path.join(target, row.path);
    rejectRedirectedOutput(output, destination);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, row.bytes);
    if (sha(readFileSync(destination)) !== row.sha256) throw new Error(`copy-hermes: copied bytes differ: ${row.path}`);
    files.push({ path: `${SKILL_RUNTIME_REL}/${row.path}`, bytes: row.bytes.length, sha256: row.sha256 });
  }

  return { sourceRoot: source, outRoot: output, targetRoot: target, copiedFiles: files.length, vendorAssetsVerified, files,
    vendorManifestPath: path.join(target, 'vendor/VENDOR-MANIFEST.json'), workerPath: path.join(target, 'host/worker.mjs') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out-root' || !path.isAbsolute(args[1])) throw new Error('Usage: copy-hermes-runtime.mjs --out-root <absolute dist root>');
  const copied = copyHermesRuntime({ outRoot: args[1] });
  console.log(JSON.stringify({ ...copied, files: undefined }));
}

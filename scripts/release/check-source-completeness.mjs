// Source inputs only: run on an exported tree before dependency installation.
// Binary availability and installed/native behavior have separate release gates.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolCatalog } from '../../desktop-services/src/tooling/tool-catalog.mjs';
import { loadRepositoryToolRegistry } from '../../desktop-services/src/tooling/tool-package-manager.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const failures = [];
let checkedFiles = 0;
function sourcePath(relative) {
  if (path.isAbsolute(relative) || relative.includes('\\')) throw new Error(`Invalid source path: ${relative}`);
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(root + path.sep)) throw new Error(`Source path escapes repository: ${relative}`);
  for (let current = absolute; current !== root; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Redirected source input: ${relative}`);
  }
  return absolute;
}
function requireFile(relative) {
  const absolute = sourcePath(relative);
  checkedFiles += 1;
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
    failures.push(`missing source input: ${relative}`);
    return null;
  }
  return absolute;
}
function json(relative) {
  const file = requireFile(relative);
  return file ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
const layout = json('tools/release/source-layout.json');
for (const entry of layout?.extraFiles ?? []) requireFile(entry.source);
// The source checkout includes this exact first-party helper. Downloaded sandbox
// helpers stay outside Git and are checked by setup-cli-native.mjs instead.
const ptyProvenance = json('new trylo cli/vendor-bin/pty/PROVENANCE.json');
const ptyArtifact = ptyProvenance?.artifacts?.['trylo-pty-win-x64'];
const ptyRelative = 'new trylo cli/vendor-bin/pty/win-x64/trylo-pty.exe';
if (ptyArtifact?.path !== 'vendor-bin/pty/win-x64/trylo-pty.exe') failures.push('invalid PTY artifact path');
else {
  const helper = requireFile(ptyRelative);
  if (helper) {
    const bytes = readFileSync(helper);
    if (bytes.length !== ptyArtifact.bytes || createHash('sha256').update(bytes).digest('hex') !== ptyArtifact.sha256) failures.push('PTY helper differs from provenance');
  }
}
const config = json('desktop/src-tauri/tauri.conf.json');
for (const icon of config?.bundle?.icon ?? []) requireFile(`desktop/src-tauri/${icon}`);
const distribution = json('desktop/distribution.json');
requireFile('desktop/.env.production');
const productionEnv = readFileSync(path.join(root, 'desktop/.env.production'), 'utf8');
if (!productionEnv.split(/\r?\n/).includes('VITE_TRYLO_DEFAULT_CLI_RUNTIME=trylo-v1')
    || !productionEnv.split(/\r?\n/).includes('VITE_TRYLO_NEW_CLI_ONLY=true')) failures.push('production must select the new-only CLI distribution');
if (distribution?.defaultCliRuntime !== 'trylo-v1' || distribution?.components?.legacyCliRuntime?.bundled !== false) failures.push('new-only distribution must default to trylo-v1 and exclude the compatibility artifact');
if (Object.entries(config?.bundle?.resources ?? {}).some(([source, target]) => /cli-legacy/.test(source + target))) failures.push('new-only bundle must not map the legacy CLI');
const catalog = createToolCatalog();
failures.push(...catalog.rejected().map(item => `invalid tool manifest: ${item.id}`));
const registry = loadRepositoryToolRegistry(path.join(root, 'tool-sources.json'));
failures.push(...registry.problems);
for (const id of ['officecli', 'playwright', 'windows-mcp', 'chrome-devtools']) {
  const manifest = catalog.get(id);
  const entry = registry.entries[id];
  if (!entry || !manifest) {
    failures.push(`missing repository tool: ${id}`);
    continue;
  }
  const expected = id === 'windows-mcp'
    ? path.join(root, 'new_tool/computer-control/Windows-MCP/src/windows_mcp/__main__.py')
    : path.join(root, 'new_tool/packages', id, manifest.version, manifest.artifact.executableRelativePath);
  const policy = id === 'windows-mcp' ? 'managed-local' : 'repository-local';
  if (entry.path !== expected || entry.policy !== policy) failures.push(`repository tool pin disagrees: ${id}`);
}
const forkRoot = 'new_tool/computer-control/Windows-MCP';
const provenance = json(`${forkRoot}/PROVENANCE.json`);
if (provenance) {
  if (provenance.hashEncoding !== 'utf8-lf' || !provenance.files?.length) throw new Error('Invalid fork source inventory');
  const seen = new Set();
  for (const item of provenance.files) {
    if (seen.has(item.path)) throw new Error(`Duplicate fork source: ${item.path}`);
    seen.add(item.path);
    if (!item.path.startsWith('src/windows_mcp/') || !item.path.endsWith('.py')) throw new Error(`Invalid fork member: ${item.path}`);
    const file = requireFile(`${forkRoot}/${item.path}`);
    if (file) {
      const digest = createHash('sha256').update(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')).digest('hex');
      if (digest !== item.sha256) failures.push(`fork source digest mismatch: ${item.path}`);
    }
  }
  const lock = requireFile(`${forkRoot}/uv.lock`);
  if (lock) {
    const digest = createHash('sha256').update(readFileSync(lock, 'utf8').replaceAll('\r\n', '\n')).digest('hex');
    if (digest !== provenance.uvLockSha256 || digest !== catalog.get('windows-mcp').artifact.uvLockSha256) failures.push('Windows-MCP lock differs from its pinned dependency source');
  }
}
// Include delayed imports and .d.ts import types; skip package imports because
// those are provided by package-lock, not copied source. Ignore prose comments.
const vendorRoot = 'new trylo cli/src/internal/adapters/sandbox/vendor/sandbox-runtime/dist';
const specifier = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](\.[^'"\r\n]+)['"]/g;
function checkVendor(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) checkVendor(file);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) {
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const match of text.matchAll(specifier)) {
        const target = path.resolve(path.dirname(file), match[1]);
        const relative = path.relative(root, target).replaceAll('\\', '/');
        sourcePath(relative);
        const typeTarget = target.endsWith('.js') ? target.slice(0, -3) + '.d.ts' : target;
        const available = entry.name.endsWith('.d.ts') ? [target, typeTarget] : [target];
        if (!available.some(candidate => existsSync(candidate) && lstatSync(candidate).isFile())) failures.push(`missing vendor import: ${path.relative(root, file)} -> ${match[1]}`);
      }
    }
  }
}
const vendorDir = sourcePath(vendorRoot);
if (existsSync(vendorDir)) checkVendor(vendorDir);
else failures.push(`missing vendor source: ${vendorRoot}`);
if (failures.length) {
  console.error('source completeness FAILED\n' + [...new Set(failures)].map(failure => `- ${failure}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`source completeness OK (${checkedFiles} input checks, ${provenance.files.length} fork modules, ${catalog.list().length} tool manifests)`);
}

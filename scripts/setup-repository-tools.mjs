// Materialise the repository-local tools with the existing pinned transports.
// No global tool directory, provider configuration or browser download is changed.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createToolCatalog } from '../desktop-services/src/tooling/tool-catalog.mjs';
import {
  BUILTIN_TOOL_IDS,
  createToolPackageManager,
  loadRepositoryToolRegistry,
} from '../desktop-services/src/tooling/tool-package-manager.mjs';
import { workspacePath } from './workspace-paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 1 || !['--check', '--install', '--help'].includes(args[0])) {
  console.error('Usage: node scripts/setup-repository-tools.mjs --check|--install|--help');
  process.exit(2);
}
if (args[0] === '--help') {
  console.log('Use --check to report the pinned tool cache. --install fills the repository cache for Windows x64 or Apple Silicon.');
  process.exit(0);
}
const target = `${process.platform}-${process.arch}`;
if (!['win32-x64', 'darwin-arm64'].includes(target)) throw new Error(`Unsupported tool setup platform: ${target}`);
const catalog = createToolCatalog({ target, supportedOnly: true });
const registry = loadRepositoryToolRegistry(path.join(root, 'desktop-services/toolchain/tool-sources.json'), target);
if (catalog.rejected().length || registry.problems.length) {
  throw new Error(`Invalid tool configuration: ${JSON.stringify({ catalog: catalog.rejected(), registry: registry.problems })}`);
}
const installRoot = workspacePath('cache', 'repository-tools', target);
const packages = createToolPackageManager({ catalog, installRoot, overrides: {} });
let failures = 0;
for (const id of BUILTIN_TOOL_IDS) {
  const manifest = catalog.get(id);
  if (!manifest) continue;
  // The Trylo Windows-MCP fork is source-managed; its Python environment is
  // installed by Desktop's tool manager, rather than a repository-local binary.
  if (id === 'windows-mcp') {
    const expected = path.join(root, 'desktop-services/toolchain/computer-control/Windows-MCP/src/windows_mcp/__main__.py');
    const entry = registry.entries[id];
    if (entry?.path !== expected || entry.policy !== 'managed-local') {
      throw new Error(`Repository source disagrees with pinned manifest: ${id}`);
    }
    const ok = existsSync(expected);
    console.log(JSON.stringify({ id, version: manifest.version, ok, state: 'managed-source', dependencies: 'installed-on-demand' }));
    if (!ok) failures += 1;
    continue;
  }
  const result = args[0] === '--install'
    ? await packages.install({ id })
    : await packages.resolve(manifest);
  const ok = args[0] === '--install' ? result.ok : result.state === 'installed';
  console.log(JSON.stringify({ id, version: manifest.version, ok, state: result.state, reasonCode: result.reasonCode, error: result.error }));
  if (!ok) failures += 1;
}
process.exitCode = failures ? 1 : 0;

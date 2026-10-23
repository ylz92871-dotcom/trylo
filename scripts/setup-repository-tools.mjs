// Materialise the repository-local tools with the existing pinned transports.
// No global tool directory, provider configuration or browser download is changed.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createToolCatalog } from '../desktop-services/src/tooling/tool-catalog.mjs';
import {
  createToolPackageManager,
  loadRepositoryToolRegistry,
} from '../desktop-services/src/tooling/tool-package-manager.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 1 || !['--check', '--install', '--help'].includes(args[0])) {
  console.error('Usage: node scripts/setup-repository-tools.mjs --check|--install|--help');
  process.exit(2);
}
if (args[0] === '--help') {
  console.log('Use --check to report local tool availability; --install downloads the four pinned tools into new_tool/packages. Windows-MCP requires Windows and uv. Browser bodies and CAD applications are separate prerequisites.');
  process.exit(0);
}
if (args[0] === '--install' && (process.platform !== 'win32' || process.arch !== 'x64')) {
  throw new Error('The repository tool manifests currently target Windows x64.');
}
const catalog = createToolCatalog();
const registry = loadRepositoryToolRegistry(path.join(root, 'tool-sources.json'));
if (catalog.rejected().length || registry.problems.length) {
  throw new Error(`Invalid tool configuration: ${JSON.stringify({ catalog: catalog.rejected(), registry: registry.problems })}`);
}
const installRoot = path.join(root, 'new_tool', 'packages');
const packages = createToolPackageManager({ catalog, installRoot, overrides: {} });
let failures = 0;
for (const [id, entry] of Object.entries(registry.entries)) {
  const manifest = catalog.get(id);
  if (!manifest) throw new Error(`Unknown repository tool: ${id}`);
  // The Trylo Windows-MCP fork is source-managed; its Python environment is
  // installed by Desktop's tool manager, rather than a repository-local binary.
  if (id === 'windows-mcp') {
    const expected = path.join(root, 'new_tool/computer-control/Windows-MCP/src/windows_mcp/__main__.py');
    if (entry.path !== expected || entry.policy !== 'managed-local') {
      throw new Error(`Repository source disagrees with pinned manifest: ${id}`);
    }
    const ok = existsSync(expected);
    console.log(JSON.stringify({ id, version: manifest.version, ok, state: 'managed-source', dependencies: 'installed-on-demand' }));
    if (!ok) failures += 1;
    continue;
  }
  const expected = path.join(installRoot, id, manifest.version, manifest.artifact.executableRelativePath);
  if (entry.path !== expected || entry.policy !== 'repository-local') {
    throw new Error(`Repository entry disagrees with pinned manifest: ${id}`);
  }
  const result = args[0] === '--install'
    ? await packages.install({ id })
    : await packages.resolve(manifest);
  const ok = args[0] === '--install' ? result.ok : result.state === 'installed';
  console.log(JSON.stringify({ id, version: manifest.version, ok, state: result.state, reasonCode: result.reasonCode, error: result.error }));
  if (!ok) failures += 1;
}
process.exitCode = failures ? 1 : 0;

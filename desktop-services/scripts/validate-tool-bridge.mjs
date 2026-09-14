// Trylo tool bridge release gate.
//
// Turns the local-first/profile/RPC rules into build failures. Run directly
// during development, and with --require-local-builds --bundle before a
// desktop release is packaged.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createToolCatalog } from '../src/tooling/tool-catalog.mjs';
import { loadRepositoryToolRegistry } from '../src/tooling/tool-package-manager.mjs';
import { TOOL_PROFILES } from '../src/tooling/tool-profile-service.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..');
const requireLocalBuilds = process.argv.includes('--require-local-builds');
const requireBundle = process.argv.includes('--bundle');
const failures = [];

function requireRule(condition, message) {
  if (!condition) failures.push(message);
}

const catalog = createToolCatalog();
requireRule(catalog.rejected().length === 0, `catalog rejects manifests: ${JSON.stringify(catalog.rejected())}`);

const localRegistryPath = path.join(repoRoot, 'tool-sources.json');
const localRegistry = loadRepositoryToolRegistry(localRegistryPath);
requireRule(localRegistry.problems.length === 0, `local registry invalid: ${localRegistry.problems.join('; ')}`);

const requiredRepositoryTools = ['officecli', 'playwright', 'windows-mcp', 'chrome-devtools'];
for (const id of requiredRepositoryTools) {
  requireRule(Boolean(catalog.get(id)), `repository-local tool '${id}' is missing from the catalog`);
  requireRule(Boolean(localRegistry.entries[id]), `repository-local tool '${id}' is missing from tool-sources.json`);
  requireRule(localRegistry.entries[id]?.policy === 'repository-local', `${id} must use repository-local policy`);
  if (requireLocalBuilds) {
    requireRule(localRegistry.entries[id]?.available === true, `${id} local entry is not built: ${localRegistry.entries[id]?.path ?? '<missing entry>'}`);
  }
}

const cadEdaIds = [
  'solidworks-mcp',
  'autocad-mcp',
  'kicad-mcp',
  'jlceda-mcp',
  'freecad-mcp',
  'blender-mcp',
];

for (const profile of Object.values(TOOL_PROFILES)) {
  requireRule(profile.hermesProfile === 'normal', `${profile.id} must carry Hermes`);
  requireRule(profile.packageIds.includes('windows-mcp'), `${profile.id} must carry desktop control`);
  const browserCount = ['playwright', 'chrome-devtools'].filter((id) => profile.packageIds.includes(id)).length;
  requireRule(browserCount === 1, `${profile.id} must carry exactly one browser implementation`);
  if (profile.surface === 'code') {
    requireRule(!profile.packageIds.includes('officecli'), `${profile.id} must keep OfficeCLI Work-only`);
  } else {
    requireRule(profile.packageIds.includes('officecli'), `${profile.id} must carry the Work Office layer`);
  }
  if (profile.id.includes('cad')) {
    for (const id of cadEdaIds) requireRule(profile.packageIds.includes(id), `${profile.id} is missing ${id}`);
  }
}

const bridgeMethods = ['setLocalOverride', 'clearLocalOverride', 'localOverrides'];
const bridgeFiles = [
  path.join(packageRoot, 'src', 'host.mjs'),
  path.join(repoRoot, 'desktop', 'src', 'services-host', 'methods.ts'),
  path.join(repoRoot, 'desktop', 'src', 'tooling', 'tooling-facade.ts'),
];
for (const file of bridgeFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const method of bridgeMethods) {
    requireRule(source.includes(method), `${path.relative(repoRoot, file)} does not expose ${method}`);
  }
}

if (requireBundle) {
  const bundlePath = path.join(packageRoot, 'dist', 'host.bundle.mjs');
  requireRule(fs.existsSync(bundlePath), 'desktop-services/dist/host.bundle.mjs is missing');
  if (fs.existsSync(bundlePath)) {
    const bundle = fs.readFileSync(bundlePath, 'utf8');
    for (const profileId of Object.keys(TOOL_PROFILES)) {
      requireRule(bundle.includes(profileId), `bundle is stale: missing profile ${profileId}`);
    }
    for (const method of bridgeMethods) {
      requireRule(bundle.includes(method), `bundle is stale: missing tooling.${method}`);
    }
  }
}

if (failures.length > 0) {
  console.error('tool bridge validation FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`tool bridge validation OK (${Object.keys(TOOL_PROFILES).length} profiles, ${requiredRepositoryTools.length} repository-local tools)`);

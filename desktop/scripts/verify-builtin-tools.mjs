import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryTree } from './stage-builtin-tools.mjs';
import { loadRepositoryToolRegistry, BUILTIN_TOOL_IDS } from '../../desktop-services/src/tooling/tool-package-manager.mjs';
import { SOFTWARE_RUNTIME_FILES } from '../../desktop-services/src/tooling/software-workspace-contract.mjs';

export async function verifyBuiltinTools(root) {
  const registry = loadRepositoryToolRegistry(path.join(root, 'tool-sources.json'));
  if (registry.problems.length) throw new Error(registry.problems.join('; '));
  for (const id of BUILTIN_TOOL_IDS) {
    const entry = registry.entries[id];
    if (entry?.policy !== 'bundled' || !entry.available) throw new Error(`Missing built-in tool: ${id}`);
  }
  const inventory = JSON.parse(await fs.readFile(path.join(root, 'inventory.json'), 'utf8'));
  const actual = await inventoryTree(root);
  for (const file of SOFTWARE_RUNTIME_FILES) if (!actual[`software-workspace/${file}`]) throw new Error(`Missing software workspace runtime: ${file}`);
  if (Object.keys(actual).length !== Object.keys(inventory.files ?? {}).length) throw new Error('Built-in inventory file count differs');
  for (const [name, digest] of Object.entries(actual)) {
    if (inventory.files[name] !== digest) throw new Error(`Built-in artifact changed: ${name}`);
  }
  for (const id of BUILTIN_TOOL_IDS) {
    const entry = registry.entries[id];
    if (actual[entry.entry] !== entry.sha256) throw new Error(`Built-in executable digest differs: ${id}`);
  }
  return { tools: BUILTIN_TOOL_IDS.length, files: Object.keys(actual).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node verify-builtin-tools.mjs <bundle-root>');
  console.log(JSON.stringify(await verifyBuiltinTools(path.resolve(process.argv[2]))));
}

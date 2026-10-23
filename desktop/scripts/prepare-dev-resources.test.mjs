// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareDevResources } from './prepare-dev-resources.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const parent = resolve('spike-results/dev-resource-tests');
  mkdirSync(parent, { recursive: true });
  const workspace = mkdtempSync(resolve(parent, 'checkout-'));
  roots.push(workspace);
  const root = resolve(workspace, 'desktop');
  mkdirSync(root);
  writeFileSync(resolve(root, 'distribution.json'), '{"product":"Trylo Desktop","distribution":"core"}\n');
  return root;
}

it('supplies the real manifest in a checkout with no staged resources', () => {
  const root = fixture();
  prepareDevResources(root);
  expect(readFileSync(resolve(root, 'src-tauri/resources/distribution.json'))).toEqual(readFileSync(resolve(root, 'distribution.json')));
});

it('updates stale manifests without touching unrelated staged sidecars or unchanged manifest timestamps', () => {
  const root = fixture();
  prepareDevResources(root);
  const target = resolve(root, 'src-tauri/resources/distribution.json');
  const sibling = resolve(root, 'src-tauri/resources/sidecar.bin');
  writeFileSync(sibling, 'existing-runtime');
  const before = statSync(target).mtimeMs;
  prepareDevResources(root);
  expect(statSync(target).mtimeMs).toBe(before);
  writeFileSync(resolve(root, 'distribution.json'), '{"distribution":"updated"}\n');
  prepareDevResources(root);
  expect(readFileSync(target, 'utf8')).toBe('{"distribution":"updated"}\n');
  expect(readFileSync(sibling, 'utf8')).toBe('existing-runtime');
});

it('rejects a missing or malformed source rather than writing a placeholder', () => {
  const root = fixture();
  writeFileSync(resolve(root, 'distribution.json'), 'broken-json');
  expect(() => prepareDevResources(root)).toThrow();
  expect(() => prepareDevResources(resolve(root, 'absent'))).toThrow();
});

it('omits only the absent release legacy resource when the checkout runtime exists', () => {
  const root = fixture();
  mkdirSync(resolve(root, 'src-tauri'), { recursive: true });
  writeFileSync(resolve(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ bundle: { resources: { 'resources/cli-legacy/': 'cli-legacy/' } } }));
  expect(() => prepareDevResources(root)).toThrow(/needs trylo cli/);
  // A sibling checkout represents the native resolver's existing development fallback.
  const legacy = resolve(root, '../trylo cli');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(resolve(legacy, 'cli.js'), '// fixture');
  try {
    expect(prepareDevResources(root)).toEqual({ bundle: { resources: { 'resources/cli-legacy/': null } } });
    mkdirSync(resolve(root, 'src-tauri/resources/cli-legacy'));
    expect(prepareDevResources(root)).toBeUndefined();
  } finally { rmSync(legacy, { recursive: true, force: true }); }
});

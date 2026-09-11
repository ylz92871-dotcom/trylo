// vendor-path.mjs：打包后仍能定位 vendor/legacy（pet-channel 曾踩过的坑）。
// 纯 Node —— 用 argv[1] 模拟 dev / bundled / packaged 三种布局。

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { resolveLegacyVendorPath, requireLegacyVendor, legacyVendorUrl } from '../../src/learning/vendor-path.mjs';

const SAVED_ARGV = process.argv.slice();

beforeEach(() => {
  process.argv = SAVED_ARGV.slice();
});
after(() => {
  process.argv = SAVED_ARGV;
});

const packageRoot = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

test('resolves a top-level legacy module', () => {
  const resolved = resolveLegacyVendorPath('hermes-capability-manager.js');
  assert.ok(resolved, 'expected the vendored manager to resolve');
  assert.equal(path.basename(resolved), 'hermes-capability-manager.js');
  assert.ok(resolved.replace(/\\/g, '/').endsWith('vendor/legacy/hermes-capability-manager.js'));
});

test('resolves a nested legacy module (learning-loop/)', () => {
  const resolved = resolveLegacyVendorPath('learning-loop/orchestrator.js');
  assert.ok(resolved);
  assert.ok(resolved.replace(/\\/g, '/').endsWith('vendor/legacy/learning-loop/orchestrator.js'));
});

test('resolves when bundled: argv[1] = dist/host.bundle.mjs', () => {
  const distEntry = path.join(packageRoot, 'dist', 'host.bundle.mjs');
  process.argv = ['node', distEntry];
  const resolved = resolveLegacyVendorPath('hermes-python-resolver.js');
  assert.equal(resolved, path.join(packageRoot, 'vendor', 'legacy', 'hermes-python-resolver.js'));
});

test('resolves when packaged: <resource>/desktop-services/dist/host.bundle.mjs', () => {
  // Build a real packaged layout in a temp dir so the argv[1] candidate is
  // the one that wins (no fallback to the dev tree).
  const resources = mkdtempSync(path.join(tmpdir(), 'trylo-resources-'));
  const pkg = path.join(resources, 'desktop-services');
  const vendorFile = path.join(pkg, 'vendor', 'legacy', 'hermes-pending-admin.js');
  mkdirSync(path.dirname(vendorFile), { recursive: true });
  writeFileSync(vendorFile, 'module.exports = {};\n', 'utf8');
  mkdirSync(path.join(pkg, 'dist'), { recursive: true });

  process.argv = ['node', path.join(pkg, 'dist', 'host.bundle.mjs')];
  assert.equal(resolveLegacyVendorPath('hermes-pending-admin.js'), vendorFile);
});

test('falls back to the dev tree when the argv[1] layout has no vendor dir', () => {
  // A path that does not exist must not win the candidate race.
  process.argv = ['node', path.join('D:', 'app', 'resources', 'desktop-services', 'dist', 'host.bundle.mjs')];
  const resolved = resolveLegacyVendorPath('hermes-pending-admin.js');
  assert.equal(resolved, path.join(packageRoot, 'vendor', 'legacy', 'hermes-pending-admin.js'));
});

test('resolves in dev: argv[1] = src/host.mjs', () => {
  process.argv = ['node', path.join(packageRoot, 'src', 'host.mjs')];
  const resolved = resolveLegacyVendorPath('history-mining-client.js');
  assert.equal(resolved, path.join(packageRoot, 'vendor', 'legacy', 'history-mining-client.js'));
});

test('an unknown module resolves to null instead of throwing (callers degrade)', () => {
  assert.equal(resolveLegacyVendorPath('does-not-exist.js'), null);
});

test('requireLegacyVendor throws a named error for a missing module', () => {
  assert.throws(() => requireLegacyVendor('does-not-exist.js'), /vendored legacy module not found/);
});

test('requireLegacyVendor loads a real vendored module', () => {
  const manager = requireLegacyVendor('hermes-capability-manager.js');
  assert.equal(typeof manager.getHermesHome, 'function');
  assert.equal(typeof manager.tryGetMcpConfigArg, 'function');
});

test('legacyVendorUrl returns an importable file:// URL', () => {
  const url = legacyVendorUrl('hermes-session-sync.js');
  assert.ok(url.startsWith('file:///'));
  assert.ok(url.includes('vendor/legacy/hermes-session-sync.js'));
  // Sanity: the URL round-trips back to the same absolute path.
  assert.ok(new URL(url).pathname.includes('hermes-session-sync.js'));
});

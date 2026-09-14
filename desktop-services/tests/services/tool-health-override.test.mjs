// Trylo Desktop Services — tool-health-service override-relaxation tests.
//
// A LOCAL OVERRIDE (the user's own self-compiled / dev build, wired via
// TRYLO_TOOL_PACKAGE_OVERRIDES) may legitimately report a version that differs
// from the pinned release. The health check must accept it as available (it
// only verifies the binary runs) while keeping the strict version pin for the
// default install path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolHealthService } from '../../src/tooling/tool-health-service.mjs';

const MANIFEST = Object.freeze({
  id: 'officecli',
  displayName: 'OfficeCLI',
  version: '1.0.145',
  adoption: 'trial',
  healthCheck: 'version-handshake',
  mcp: Object.freeze({ serverName: 'trylo-office', expectedTools: ['officecli'] }),
  artifact: Object.freeze({ runner: 'release-archive', executableRelativePath: 'officecli-win-x64.exe' }),
  expectedTools: ['officecli'],
});

function checkWith({ state, reported }) {
  const packages = {
    resolve: async () => ({
      id: 'officecli',
      version: MANIFEST.version,
      installDir: '/fake',
      executable: '/fake/officecli-win-x64.exe',
      state,
      detail: state === 'override' ? 'dev override: officecli-win-x64.exe' : 'ok',
      autoUpdate: false,
    }),
  };
  const health = createToolHealthService({ packages, probe: async () => reported });
  return health.check(MANIFEST, { deep: true });
}

test('a local override whose version differs from the pin is ACCEPTED', async () => {
  // Self-compiled build reports 2.0.0-dev, not the pinned 1.0.145.
  const rec = await checkWith({ state: 'override', reported: 'OfficeCLI v2.0.0-dev\n' });
  assert.equal(rec.available, true); // accepted despite the version drift
  assert.equal(rec.state, 'override');
  assert.equal(rec.reportedVersion, 'OfficeCLI v2.0.0-dev\n');
  assert.equal(rec.versionMatches, false); // truthfully reported, but not refused
});

test('the default install path still refuses a version drift', async () => {
  const rec = await checkWith({ state: 'installed', reported: 'OfficeCLI v2.0.0-dev\n' });
  assert.equal(rec.available, false);
  assert.equal(rec.state, 'version-mismatch');
  assert.equal(rec.versionMatches, false);
});

test('the default install path accepts a matching version', async () => {
  const rec = await checkWith({ state: 'installed', reported: 'OfficeCLI v1.0.145\n' });
  assert.equal(rec.available, true);
  assert.equal(rec.state, 'installed');
  assert.equal(rec.versionMatches, true);
});
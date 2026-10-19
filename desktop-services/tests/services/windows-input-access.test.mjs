import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolHealthService } from '../../src/tooling/tool-health-service.mjs';
import { WINDOWS_MCP_MANIFEST } from '../../src/tooling/manifests/windows-mcp.mjs';

for (const state of ['override', 'installed']) {
  test(`${state}: a valid Windows-MCP version cannot mask a Low input runtime`, async () => {
    const health = createToolHealthService({
      packages: { resolve: async () => ({state, executable:'C:/tools/windows-mcp.exe'}) },
      probePythonMetadata: async () => '0.8.5',
      probeInputAccess: async () => ({available:false, integrityRid:4096, uiAccess:false, reason:'input_runtime_low_integrity'}),
    });
    const result = await health.check(WINDOWS_MCP_MANIFEST);
    assert.equal(result.available, false);
    assert.equal(result.reportedVersion, '0.8.5');
    assert.match(result.detail, /Low/);
    assert.equal(result.inputAccess.integrityRid,4096);
  });
}

test('input access probe failure remains unavailable', async () => {
  const health = createToolHealthService({
    packages: { resolve: async () => ({state:'installed', executable:'C:/tools/windows-mcp.exe'}) },
    probePythonMetadata: async () => '0.8.5',
    probeInputAccess: async () => ({available:false, reason:'input_permission_probe_failed'}),
  });
  assert.equal((await health.check(WINDOWS_MCP_MANIFEST)).available,false);
});

test('a token or executable-label change is observed without waiting for the version cache', async () => {
  let available = false;
  const health = createToolHealthService({
    packages: { resolve: async () => ({ state: 'installed', executable: 'C:/tools/windows-mcp.exe' }) },
    probePythonMetadata: async () => '0.8.5',
    probeInputAccess: async () => ({ available, reason: available ? null : 'input_runtime_low_integrity' }),
  });
  assert.equal((await health.check(WINDOWS_MCP_MANIFEST)).available, false);
  available = true;
  assert.equal((await health.check(WINDOWS_MCP_MANIFEST)).available, true);
  available = false;
  assert.equal((await health.check(WINDOWS_MCP_MANIFEST)).available, false);
});

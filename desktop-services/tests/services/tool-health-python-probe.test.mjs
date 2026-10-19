// Trylo Desktop Services — python-metadata probe stability tests.
//
// WHY THIS FILE EXISTS (2026-10-03, owner's machine, windows-mcp 0.8.5 under a
// local override): the "缺少可选工具" notice listed Windows-MCP on turns 2 and
// 3 of one conversation but not on turns 1 and 4. Nothing about the install
// changed. Five consecutive real probes of
//   <venv>\Scripts\python.exe -c "import importlib.metadata as md; ..."
// measured null@2002ms, null@2008ms, '0.8.5'@1869ms, '0.8.5'@1772ms,
// null@2015ms — the real cost straddles the 2s bound, so the verdict flipped
// run to run.
//
// The fix is a bound that clears the measured cost plus ONE bounded retry
// (matching the PR-7 treatment `probeVersion` already had). These tests pin
// both halves: the retry must rescue a transient, and it must NOT turn a
// genuinely silent interpreter into 可用.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolHealthService } from '../../src/tooling/tool-health-service.mjs';

const MANIFEST = Object.freeze({
  id: 'windows-mcp',
  displayName: 'Windows-MCP',
  version: '0.8.5',
  adoption: 'trial',
  healthCheck: 'python-metadata',
  mcp: Object.freeze({ serverName: 'trylo-windows', expectedTools: ['Screenshot'] }),
  artifact: Object.freeze({
    runner: 'pinned-python-env',
    executableRelativePath: '.venv/Scripts/windows-mcp.exe',
    pythonPackage: 'windows-mcp',
  }),
});

/** Resolve the package as installed, then run `health.check` with a scripted
 *  python-metadata probe. `answers` is consumed one entry per attempt; a
 *  missing entry behaves as a probe that never answers. */
function checkWithProbe(answers) {
  const calls = [];
  const packages = {
    resolve: async () => ({
      id: MANIFEST.id,
      version: MANIFEST.version,
      installDir: '/fake/windows-mcp/0.8.5',
      executable: '/fake/windows-mcp/0.8.5/.venv/Scripts/windows-mcp.exe',
      state: 'installed',
      detail: 'digest verified',
      autoUpdate: false,
    }),
  };
  const health = createToolHealthService({
    packages,
    probeInputAccess: async () => ({available:true, integrityRid:8192, uiAccess:false}),
    probePythonMetadata: async () => {
      calls.push(calls.length);
      return answers[calls.length - 1] ?? null;
    },
  });
  return health.check(MANIFEST, { deep: true }).then((record) => ({ record, calls: calls.length }));
}

test('a python-metadata probe that times out once and then answers is AVAILABLE', async () => {
  // The real-world transient: attempt 1 hits the bound, attempt 2 answers.
  const { record, calls } = await checkWithProbe([null, '0.8.5']);
  assert.equal(calls, 2, 'a first miss must trigger exactly one bounded retry');
  assert.equal(record.available, true);
  assert.equal(record.state, 'installed');
  assert.equal(record.reportedVersion, '0.8.5');
  assert.equal(record.versionMatches, true);
});

test('a python-metadata probe that never answers stays NOT installed', async () => {
  // The retry is not a pardon: a venv that cannot report a version, twice,
  // is still unavailable. This is the assertion that must NOT be relaxed.
  const { record, calls } = await checkWithProbe([null, null]);
  assert.equal(calls, 2);
  assert.equal(record.available, false);
  assert.equal(record.state, 'not-installed');
  assert.equal(record.reportedVersion, null);
});

test('a python-metadata probe answering on the first try does not probe twice', async () => {
  const { record, calls } = await checkWithProbe(['0.8.5']);
  assert.equal(calls, 1, 'a healthy venv must not pay for a retry it does not need');
  assert.equal(record.available, true);
});

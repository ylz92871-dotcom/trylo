// mcp-args-service.mjs：委派给 vendor 的三份 profile（spec §7.2）。
// 纯 Node 单测 —— 通过 seam 注入 fake manager，不 spawn Python。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createMcpArgsService, MCP_PROFILES } from '../../src/learning/mcp-args-service.mjs';

const STORAGE_ROOT = path.join('/data', 'app', 'Trylo');

function fakeManager(overrides = {}) {
  const calls = [];
  const record = (name) => (root) => {
    calls.push({ name, root });
    return (overrides[name] ?? (() => ({
      ok: true,
      arg: ['--mcp-config', '{}'],
      warning: null,
      allowedTools: ['memory_search'],
      configPath: path.join(root, 'config.json'),
      hermesHome: path.join(root, 'hermes-capabilities', 'v1'),
    })))();
  };
  return {
    calls,
    manager: {
      tryGetMcpConfigArg: record('normal'),
      tryGetLearningMcpConfigArg: record('learning'),
      tryGetHistoryMcpConfigArg: record('history'),
    },
  };
}

test('profiles: normal / learning / history', () => {
  assert.deepEqual(MCP_PROFILES, ['normal', 'learning', 'history']);
});

test('each profile delegates to its legacy builder with the storage root', () => {
  const cases = [
    ['normal', 'tryGetMcpConfigArg'],
    ['learning', 'tryGetLearningMcpConfigArg'],
    ['history', 'tryGetHistoryMcpConfigArg'],
  ];
  for (const [profile, method] of cases) {
    const { calls, manager } = fakeManager();
    const service = createMcpArgsService({ storageRoot: STORAGE_ROOT, manager });
    const result = service.mcpArgs({ profile });
    assert.equal(result.ok, true, profile);
    assert.equal(result.profile, profile);
    assert.deepEqual(result.arg, ['--mcp-config', '{}']);
    assert.deepEqual(calls, [{ name: profile, root: STORAGE_ROOT }], method);
  }
});

test('default profile is normal', () => {
  const { calls, manager } = fakeManager();
  const service = createMcpArgsService({ storageRoot: STORAGE_ROOT, manager });
  assert.equal(service.mcpArgs().ok, true);
  assert.equal(calls[0]?.name, 'normal');
});

test('unknown profile is rejected without touching the manager', () => {
  const { calls, manager } = fakeManager();
  const service = createMcpArgsService({ storageRoot: STORAGE_ROOT, manager });
  const result = service.mcpArgs({ profile: 'nope' });
  assert.equal(result.ok, false);
  assert.match(result.warning, /unknown hermes mcp profile/);
  assert.deepEqual(result.arg, []);
  assert.deepEqual(calls, []);
});

test('unconfigured storage root degrades with a warning (main run continues)', () => {
  const { calls, manager } = fakeManager();
  const service = createMcpArgsService({ storageRoot: '', manager });
  const result = service.mcpArgs({ profile: 'normal' });
  assert.equal(result.ok, false);
  assert.match(result.warning, /storage root is not configured/);
  assert.deepEqual(calls, []);
});

test('degrade warning and allowlist are passed through verbatim, never rewritten', () => {
  const { manager } = fakeManager({
    learning: () => ({ ok: false, arg: [], warning: 'Hermes not installed' }),
    history: () => ({
      ok: true,
      arg: ['--mcp-config', '{}'],
      warning: null,
      allowedTools: ['session_search', 'history_search'],
      configPath: '/x/config.json',
      hermesHome: '/x/hermes-capabilities/v1',
    }),
  });
  const service = createMcpArgsService({ storageRoot: STORAGE_ROOT, manager });

  const degraded = service.mcpArgs({ profile: 'learning' });
  assert.equal(degraded.ok, false);
  assert.equal(degraded.warning, 'Hermes not installed');
  assert.deepEqual(degraded.arg, []);

  const history = service.mcpArgs({ profile: 'history' });
  assert.deepEqual(history.allowedTools, ['session_search', 'history_search']);
  assert.equal(history.configPath, '/x/config.json');
});

test('returned arrays are copies — callers cannot mutate the service state', () => {
  const { manager } = fakeManager();
  const service = createMcpArgsService({ storageRoot: STORAGE_ROOT, manager });
  const first = service.mcpArgs({ profile: 'normal' });
  first.arg.push('--injected');
  assert.deepEqual(service.mcpArgs({ profile: 'normal' }).arg, ['--mcp-config', '{}']);
});

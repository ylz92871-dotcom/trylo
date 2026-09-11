// learning-loop-service.mjs：3C 的委派与降级（spec §7.6）。
// 纯 Node 单测 —— 注入 fake orchestrator / mining client，不 spawn Python。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createLearningLoopService } from '../../src/learning/learning-loop-service.mjs';

const STORAGE_ROOT = path.join('/data', 'app', 'Trylo');

function fakeOrchestrator() {
  const calls = [];
  return {
    calls,
    orchestrator: {
      runImplicitReview: async (params) => {
        calls.push({ method: 'runImplicitReview', params });
        return { status: 'ok', candidateId: 'c1' };
      },
      runExplicitLearn: async (params) => {
        calls.push({ method: 'runExplicitLearn', params });
        return { status: 'ok', candidateId: 'c2' };
      },
      getActiveRunStatus: (workspaceRoot) => {
        calls.push({ method: 'getActiveRunStatus', workspaceRoot });
        return workspaceRoot === 'd:/busy'
          ? { workspace: 'd:/busy', active: true, candidateId: 'c1', status: 'running', mode: 'implicit', startedAt: 1 }
          : null;
      },
    },
  };
}

function fakeMining(result) {
  const calls = [];
  return {
    calls,
    mining: {
      runHistorySearch: async (options) => {
        calls.push(options);
        return result ?? { ok: true, results: [], truncated: false };
      },
    },
  };
}

function fakeMemento() {
  const map = new Map();
  return {
    get: async (key, fallback) => (map.has(key) ? map.get(key) : fallback),
    update: async (key, value) => { map.set(key, value); },
  };
}

function build(overrides = {}) {
  const { calls, orchestrator } = fakeOrchestrator();
  const mining = fakeMining(overrides.miningResult);
  const shadow = { configure: () => {}, run: async () => ({ answer: '{}' }), ...(overrides.shadow ?? {}) };
  const service = createLearningLoopService({
    storageRoot: STORAGE_ROOT,
    memento: fakeMemento(),
    shadow,
    orchestrator,
    mining: mining.mining,
    log: overrides.log ?? null,
  });
  return { service, calls, miningCalls: mining.calls };
}

test('reviewImplicit passes the memento as the legacy globalState', async () => {
  const { service, calls } = build();
  await service.reviewImplicit({
    workspaceRoot: 'd:/repo',
    sessionId: 's1',
    turnId: 't1',
    mode: 'agent',
    resultText: 'done',
    taskGoal: 'fix the bug',
    events: [{ id: 'e1', category: 'edit', title: 'edit file', status: 'success' }],
  });

  const params = calls[0].params;
  assert.equal(params.globalStoragePath, STORAGE_ROOT);
  assert.equal(typeof params.context.globalState.get, 'function');
  assert.equal(typeof params.context.globalState.update, 'function');
  assert.equal(params.workspaceRoot, 'd:/repo');
  assert.equal(params.resultText, 'done');
  assert.equal(params.taskGoal, 'fix the bug');
  assert.deepEqual(params.events, [{ id: 'e1', category: 'edit', title: 'edit file', status: 'success' }]);
});

test('reviewImplicit normalises missing collections to empty arrays', async () => {
  const { service, calls } = build();
  await service.reviewImplicit({ workspaceRoot: 'd:/repo' });
  const params = calls[0].params;
  assert.deepEqual(params.events, []);
  assert.deepEqual(params.fileHints, []);
  assert.deepEqual(params.verification, []);
  assert.equal(params.mode, 'agent');
});

test('learnExplicit forwards the /learn request', async () => {
  const { service, calls } = build();
  const result = await service.learnExplicit({
    workspaceRoot: 'd:/repo',
    sessionId: 's1',
    turnId: 't1',
    learnRequest: 'turn this into a skill',
  });
  assert.equal(result.ok, true);
  assert.equal(result.candidateId, 'c2');
  assert.equal(calls[0].params.learnRequest, 'turn this into a skill');
});

test('trace logging goes to the Desktop sink, never to stdout', async () => {
  const logged = [];
  const { service, calls } = build({ log: (m) => logged.push(m) });
  await service.reviewImplicit({ workspaceRoot: 'd:/repo' });
  calls[0].params.logTrace('learning implicit: skipped, cooldown');
  assert.deepEqual(logged, ['learning implicit: skipped, cooldown']);
});

test('runStatus reports the active run (single-flight visibility)', () => {
  const { service } = build();
  assert.deepEqual(service.runStatus({ workspaceRoot: 'd:/busy' }), {
    ok: true,
    active: true,
    run: { workspace: 'd:/busy', active: true, candidateId: 'c1', status: 'running', mode: 'implicit', startedAt: 1 },
  });
  assert.deepEqual(service.runStatus(), { ok: true, active: false, run: null });
});

test('historySearch forwards queries/limit and passes the validated results through', async () => {
  const { service, miningCalls } = build({
    miningResult: { ok: true, results: [{ sessionId: 's1', taskSummary: 'x' }], truncated: false },
  });
  const result = await service.historySearch({ queries: ['q1'], limit: 20 });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.deepEqual(miningCalls[0], { queries: ['q1'], limit: 20, globalStoragePath: STORAGE_ROOT, timeoutMs: undefined });
});

test('historySearch treats a non-array queries input as empty', async () => {
  const { service, miningCalls } = build();
  await service.historySearch({ queries: 'nope' });
  assert.deepEqual(miningCalls[0].queries, []);
});

test('unconfigured storage root is rejected before the legacy code runs', async () => {
  const { calls, orchestrator } = fakeOrchestrator();
  const service = createLearningLoopService({
    storageRoot: '',
    memento: fakeMemento(),
    shadow: { configure: () => {}, run: async () => ({ answer: '{}' }) },
    orchestrator,
    mining: fakeMining().mining,
  });
  await assert.rejects(() => service.reviewImplicit({}), /storage root is not configured/);
  await assert.rejects(() => service.historySearch({}), /storage root is not configured/);
  assert.deepEqual(calls, []);
});

test('the shadow runner receives the per-run CLI config from the renderer', async () => {
  const configured = [];
  const { service, calls } = build({ shadow: { configure: (cli) => configured.push(cli) } });
  await service.reviewImplicit({ workspaceRoot: 'd:/repo', cli: { cliPath: 'd:/cli/trylo.js', cwd: 'd:/repo' } });
  assert.deepEqual(configured, [{ cliPath: 'd:/cli/trylo.js', cwd: 'd:/repo' }]);
  assert.equal(typeof calls[0].params.runInShadow, 'function');
});

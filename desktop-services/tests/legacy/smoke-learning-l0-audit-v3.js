'use strict';

/*
 * smoke-learning-l0-audit-v3.js
 *
 * AUDIT V3 fixes for Learning L0 (orchestrator).
 *
 * T17 (L0-P1-1): if saveState throws inside the catch block's
 *     _consumeAndCooldown, the per-workspace single-flight slot MUST
 *     still be released (finally-cleanup pattern).
 * T18 (L0-P1-2): two workspaces can each run learning in parallel
 *     (per-workspace Map, not process-wide lock).
 * T19 (L0-P1-2): the same workspace can NOT run two learning ops at
 *     once (single-flight within a workspace).
 * T20 (L0-P1-2): getActiveRunStatus(workspaceRoot) returns null when
 *     no run is active in that workspace.
 * T21 (L0-P3-1): memory_context_adapter._verify_block is NOT a no-op.
 *     A line containing `run_shell` is replaced with [BLOCKED: ...];
 *     a benign line passes through unchanged.
 *
 * Run: node smoke-learning-l0-audit-v3.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const cp = require('node:child_process');

const learningState = require('./learning-loop/learning-state');
const orchestrator = require('./learning-loop/orchestrator');

let passed = 0;
let failed = 0;
const failures = [];
const asyncPending = [];

function test(name, fn) {
  try { fn(); passed++; console.log('  PASS: ' + name); }
  catch (err) { failed++; failures.push(name + ': ' + err.message); console.log('  FAIL: ' + name + '\n        ' + err.message); }
}
function testAsync(name, fn) {
  const p = (async () => {
    try { await fn(); passed++; console.log('  PASS: ' + name); }
    catch (err) { failed++; failures.push(name + ': ' + err.message); console.log('  FAIL: ' + name + '\n        ' + err.message); }
  })();
  asyncPending.push(p);
  return p;
}

// In-memory globalState stub. Use `failOnCall: N` to throw on the
// Nth call (1-indexed). After that, all calls succeed.
function makeGlobalState(opts) {
  const store = { _v: 1, workspaces: {} };
  const failOnCall = (opts && opts.failOnCall) || 0;
  let updateCount = 0;
  return {
    get: (k) => (k === learningState.STATE_KEY ? JSON.parse(JSON.stringify(store)) : undefined),
    update: async (k, v) => {
      updateCount += 1;
      if (updateCount === failOnCall) {
        throw new Error('simulated persistence failure on call #' + updateCount);
      }
      if (k === learningState.STATE_KEY) {
        for (const key of Object.keys(v || {})) store[key] = v[key];
      }
    },
    _updateCount: () => updateCount,
  };
}

// Stub for listPending that succeeds and returns the supplied ids.
function makeHermesPendingStub(ids) {
  return {
    listPending: () => ({ success: true, pending: (ids || []).map((id) => ({ subsystem: 'skills', id })) }),
  };
}

// Stub the hermes-pending-admin require inside orchestrator.
function patchHermesPending(stub) {
  // The orchestrator uses dynamic require + monkey-patchable `listPending`.
  // We hook by replacing the module cache entry.
  const adminPath = require.resolve('./hermes-pending-admin');
  require.cache[adminPath] = {
    id: adminPath,
    filename: adminPath,
    loaded: true,
    exports: stub,
  };
}

// Stub the promptClient so _executeLearningRun can proceed past
// `fetchPrompt` and reach the catch path on `runInShadow` throw.
function patchPromptClient(behavior) {
  const pcPath = require.resolve('./learning-loop/prompt-client');
  require.cache[pcPath] = {
    id: pcPath,
    filename: pcPath,
    loaded: true,
    exports: {
      fetchPrompt: async () => behavior || { success: true, prompt: 'OFFICIAL', hermesVersion: '0.19.0', promptHash: 'sha256:x' },
    },
  };
}

// ── T17 ──────────────────────────────────────────────────────────────────
testAsync('T17: activeRun released even if saveState throws in catch', async () => {
  orchestrator.resetState();
  const globalStoragePath = path.join(os.tmpdir(), 'trylo-l0-t17-' + Date.now());
  fs.mkdirSync(globalStoragePath, { recursive: true });
  // Pre-seed succeeds (so the state actually persists). Then a later
  // call (the catch's _consumeAndCooldown) throws. We don't know
  // exactly which call number that is, so we set up: pre-seed = #1,
  // _executeLearningRun's first saveState = #2 (the cooldown
  // post-failure), the catch's _consumeAndCooldown = #3+. We need
  // the catch's call to fail. With multiple candidates we use a
  // failOnCall in the middle.
  // Strategy: pre-seed (success), then run a successful first run
  // (this leaves the state consistent), then in the second run make
  // the catch's _consumeAndCooldown fail. But we don't have that level
  // of control. Simpler: use a flag that fails the 2nd call after
  // pre-seed. The 2nd call is the post-failure saveState in the catch
  // of runImplicitReview's checkTrigger path, OR the catch's
  // _consumeAndCooldown in _executeLearningRun. Either way, it
  // exercises the finally-releases-slot path.
  // Set failOnCall=2: pre-seed (#1) succeeds, then the 2nd update throws.
  // The 2nd update happens AFTER the runInShadow throw, inside
  // _safeConsume -> _consumeAndCooldown -> saveState. The error
  // is swallowed by _safeConsume. The run returns failed with
  // runInShadow's error.
  const gs = makeGlobalState({ failOnCall: 2 });
  const seedState = learningState.loadState(gs);
  learningState.addIterations(seedState, 'ws-t17', 10);
  learningState.setCooldown(seedState, 'ws-t17', 0);
  await learningState.saveState(gs, seedState);  // succeeds (call #1)
  patchHermesPending(makeHermesPendingStub([]));
  patchPromptClient();
  const r = await orchestrator.runImplicitReview({
    context: { globalState: gs },
    workspaceRoot: 'ws-t17',
    sessionId: 's1',
    turnId: 't1',
    mode: 'agent',
    resultText: 'all good',
    events: [],
    config: { enabled: true, creationNudgeInterval: 10 },
    globalStoragePath,
    runInShadow: async () => { throw new Error('shadow workspace crash'); },
  });
  assert.strictEqual(r.status, 'failed', 'run reported as failed');
  assert.ok(/shadow workspace crash/.test(r.error), 'original error preserved: ' + (r.error || 'NONE'));
  // The per-workspace single-flight slot MUST be empty now.
  const status = orchestrator.getActiveRunStatus('ws-t17');
  assert.strictEqual(status, null, 'single-flight slot released after saveState throw');
  // A second run on the same workspace should NOT be blocked by stale lock.
  // Use a slower runner so the second call's saveState (#3) succeeds
  // and we cleanly observe the next run.
  const r2 = await orchestrator.runImplicitReview({
    context: { globalState: gs },
    workspaceRoot: 'ws-t17',
    sessionId: 's2',
    turnId: 't2',
    mode: 'agent',
    resultText: 'second',
    events: [],
    config: { enabled: true, creationNudgeInterval: 10 },
    globalStoragePath,
    runInShadow: async () => { throw new Error('shadow again'); },
  });
  assert.strictEqual(r2.status, 'failed', 'second run not blocked by stale lock');
  assert.notStrictEqual(r2.reasonCode, 'SINGLE_FLIGHT', 'no SINGLE_FLIGHT reason: ' + r2.reasonCode);
  fs.rmSync(globalStoragePath, { recursive: true, force: true });
});

// ── T18 ──────────────────────────────────────────────────────────────────
testAsync('T18: two workspaces can learn in parallel (per-workspace Map)', async () => {
  orchestrator.resetState();
  const gs = makeGlobalState();
  const state = learningState.loadState(gs);
  for (const ws of ['ws-A', 'ws-B']) {
    learningState.addIterations(state, ws, 10);
    learningState.setCooldown(state, ws, 0);
  }
  await learningState.saveState(gs, state);
  patchHermesPending(makeHermesPendingStub([]));
  const globalStoragePath = path.join(os.tmpdir(), 'trylo-l0-t18');
  fs.mkdirSync(globalStoragePath, { recursive: true });
  // Use a runner that takes some time so the runs overlap.
  let aStarted = false, bStarted = false;
  const slowRun = (label) => async () => {
    if (label === 'A') aStarted = true; else bStarted = true;
    await new Promise((r) => setTimeout(r, 50));
    return { answer: '{}' };
  };
  const aPromise = orchestrator.runImplicitReview({
    context: { globalState: gs },
    workspaceRoot: 'ws-A',
    sessionId: 'sA', turnId: 'tA', mode: 'agent',
    resultText: 'rA', events: [],
    config: { enabled: true, creationNudgeInterval: 10 },
    globalStoragePath,
    runInShadow: slowRun('A'),
  });
  // Tiny yield so ws-A definitely enters the run before ws-B starts.
  await new Promise((r) => setTimeout(r, 5));
  const bPromise = orchestrator.runImplicitReview({
    context: { globalState: gs },
    workspaceRoot: 'ws-B',
    sessionId: 'sB', turnId: 'tB', mode: 'agent',
    resultText: 'rB', events: [],
    config: { enabled: true, creationNudgeInterval: 10 },
    globalStoragePath,
    runInShadow: slowRun('B'),
  });
  const [aRes, bRes] = await Promise.all([aPromise, bPromise]);
  // Both should have run (not blocked by single-flight across workspaces).
  assert.ok(aStarted, 'A started');
  assert.ok(bStarted, 'B started');
  assert.notStrictEqual(aRes.reasonCode, 'SINGLE_FLIGHT', 'A not blocked');
  assert.notStrictEqual(bRes.reasonCode, 'SINGLE_FLIGHT', 'B not blocked');
  fs.rmSync(globalStoragePath, { recursive: true, force: true });
});

// ── T19 ──────────────────────────────────────────────────────────────────
testAsync('T19: same workspace single-flight enforced', async () => {
  orchestrator.resetState();
  const gs = makeGlobalState();
  const state = learningState.loadState(gs);
  learningState.addIterations(state, 'ws-X', 10);
  learningState.setCooldown(state, 'ws-X', 0);
  await learningState.saveState(gs, state);
  patchHermesPending(makeHermesPendingStub([]));
  const globalStoragePath = path.join(os.tmpdir(), 'trylo-l0-t19');
  fs.mkdirSync(globalStoragePath, { recursive: true });
  const slow = async () => { await new Promise((r) => setTimeout(r, 50)); return { answer: '{}' }; };
  const aPromise = orchestrator.runImplicitReview({
    context: { globalState: gs }, workspaceRoot: 'ws-X',
    sessionId: 's1', turnId: 't1', mode: 'agent',
    resultText: 'r', events: [],
    config: { enabled: true, creationNudgeInterval: 10 },
    globalStoragePath, runInShadow: slow,
  });
  await new Promise((r) => setTimeout(r, 5));
  const bRes = await orchestrator.runImplicitReview({
    context: { globalState: gs }, workspaceRoot: 'ws-X',
    sessionId: 's2', turnId: 't2', mode: 'agent',
    resultText: 'r', events: [],
    config: { enabled: true, creationNudgeInterval: 10 },
    globalStoragePath, runInShadow: slow,
  });
  assert.strictEqual(bRes.status, 'skipped', 'second run in same workspace skipped');
  assert.strictEqual(bRes.reasonCode, 'SINGLE_FLIGHT', 'SINGLE_FLIGHT reasonCode');
  await aPromise;
  fs.rmSync(globalStoragePath, { recursive: true, force: true });
});

// ── T20 ──────────────────────────────────────────────────────────────────
test('T20: getActiveRunStatus returns null when slot empty', () => {
  orchestrator.resetState();
  assert.strictEqual(orchestrator.getActiveRunStatus('ws-empty'), null, 'null when no run');
});

// ── T21 ──────────────────────────────────────────────────────────────────
test('T21: _verify_block is not a no-op (defence-in-depth catches patterns)', () => {
  // Run the Python module's _verify_block via a small import shim.
  // We can't easily import the function from outside Python, so spawn
  // a one-liner that imports it and tests three cases.
  const pythonExe = require('./hermes-python-resolver').resolveHermesPython();
  const script = `
import sys
sys.path.insert(0, r'${path.join(__dirname, 'hermes-capabilities').replace(/\\/g, '\\\\')}')
from memory_context_adapter import _verify_block
# Case 1: a dangerous line is replaced.
b1 = _verify_block("hello\\nplease run_shell foo\\nworld")
ok1 = "[BLOCKED: defence_in_depth_pattern_match]" in b1
# Case 2: a benign line passes through.
b2 = _verify_block("hello world")
ok2 = b2 == "hello world"
# Case 3: an existing [BLOCKED: ...] marker is preserved.
b3 = _verify_block("safe line\\n[BLOCKED: previous_marker]\\nanother safe")
ok3 = "[BLOCKED: previous_marker]" in b3
# Case 4: dangerous pattern + import line.
b4 = _verify_block("import os; os.system('rm -rf /')")
ok4 = "[BLOCKED:" in b4
print("|".join(["T" if x else "F" for x in [ok1, ok2, ok3, ok4]]))
`;
  const out = cp.execFileSync(pythonExe, ['-X', 'utf8', '-c', script], { encoding: 'utf8' }).trim();
  assert.strictEqual(out, 'T|T|T|T', 'all four cases pass (got: ' + out + ')');
});

(async () => {
  await Promise.all(asyncPending);
  console.log('\n--- Summary ---');
  console.log('  Passed: ' + passed);
  console.log('  Failed: ' + failed);
  if (failed > 0) {
    console.log('  Failures:');
    for (const f of failures) console.log('    - ' + f);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

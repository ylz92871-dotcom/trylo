'use strict';

/*
 * smoke-learning-l6.js
 *
 * L6 (34 §6 / §14.2) — controlled automation & ops behaviour tests. 11/0.
 *
 * T0  self-test fail
 * T1  job CRUD / 启停 / runNow
 * T2  idempotency (runId = jobId + ':' + scheduledForTime)
 * T3  C-level structural unreachability (grep + dynamic reject)
 * T4  child timeout / abort (runNow + abort)
 * T5  B-level budget (second call -> BUDGET_EXHAUSTED, 0 model calls)
 * T6  disabled job does not run
 * T7  cross-window lock stale preempt + cancel-then-purge order
 * T8  dual window simulation: only one tick runs
 * T9  no resource leak: 100 ticks + 20 jobs, no growth
 * T10 log scrubbing (no body, max 200, no SKILL.md path)
 *
 * Run: node smoke-learning-l6.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ls = require('./learning-loop/learning-state');
const { JobRegistry, REJECTION_CODES } = require('./learning-loop/jobs/registry');
const { Scheduler } = require('./learning-loop/jobs/scheduler');
const { purgeWorkspace } = require('./learning-loop/jobs/propagation');
const { redactErrorText } = require('./learning-loop/jobs/redact');

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

function freshData() {
  return { schemaVersion: ls.STATE_SCHEMA_VERSION, workspaces: {} };
}

function makeReg(data, log) {
  return new JobRegistry({ state: ls, data, logger: log || (() => {}) });
}
function makeSched(opts) {
  return new Scheduler(Object.assign({ state: ls, persist: async () => {} }, opts));
}

// ── T0 ───────────────────────────────────────────────────────────────────
test('T0: self-test yields exit code 1', () => {
  if (process.argv.includes('--self-test-fail')) {
    assert.strictEqual(1, 2, 'self-test deliberate failure');
  }
  assert.ok(passed >= 0, 'test counter should be non-negative');
});

// ── T1 ───────────────────────────────────────────────────────────────────
testAsync('T1: job CRUD / enable-disable / runNow', async () => {
  const data = freshData();
  const reg = makeReg(data);
  let dispatched = 0;
  const runners = { 'index-rebuild': async () => { dispatched += 1; return { status: 'done', modelCalls: 0, artifacts: { rebuiltSessions: 1 } }; } };
  const sched = makeSched({ registry: reg, runners, data, ownerId: 't1', tickMs: 60_000 });
  for (let i = 0; i < 5; i++) {
    reg.register({ jobId: 'a-' + i, type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  }
  assert.strictEqual(reg.list().length, 5, '5 defs registered');
  const def0 = reg.get('a-0');
  const origNext = def0.nextRunAt;
  reg.update('a-0', { enabled: false });
  assert.strictEqual(reg.get('a-0').nextRunAt, origNext, 'disable preserves nextRunAt');
  reg.update('a-0', { enabled: true, nextRunAt: Date.now() });
  const a0 = reg.get('a-0');
  assert.ok(a0.nextRunAt <= Date.now() + 5_000, 'enable re-anchors nextRunAt to now');
  const r = await sched.runNow('a-0');
  assert.strictEqual(r.ok, true, 'runNow ok');
  assert.strictEqual(dispatched, 1, 'runNow dispatched the runner');
  const runs = ls.listJobRuns(data, { jobId: 'a-0' });
  assert.ok(runs.length === 1 && runs[0].status === 'done', 'run is recorded as done');
  await sched.stop();
});

// ── T2 ───────────────────────────────────────────────────────────────────
testAsync('T2: idempotency — same runId is not re-executed', async () => {
  const data = freshData();
  const reg = makeReg(data);
  let sideEffect = 0;
  const runners = { 'index-rebuild': async () => { sideEffect += 1; return { status: 'done', modelCalls: 0 }; } };
  const sched = makeSched({ registry: reg, runners, data, ownerId: 't2a', tickMs: 60_000 });
  reg.register({ jobId: 'idem', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  const origNext = Date.now() - 1;
  reg.update('idem', { enabled: true, nextRunAt: origNext });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 30));
  const runsBefore = ls.listJobRuns(data, { jobId: 'idem' });
  assert.strictEqual(sideEffect, 1, 'side-effect executed exactly once');
  assert.strictEqual(runsBefore.length, 1, 'one run record');
  // Second tick: re-anchor to the same runId key (jobId + origNext).
  reg.update('idem', { enabled: true, nextRunAt: origNext });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(sideEffect, 1, 'second tick with same runId is skipped');
  // Restart: new scheduler instance must NOT re-run the same runId.
  const sched2 = makeSched({ registry: reg, runners, data, ownerId: 't2b', tickMs: 60_000 });
  reg.update('idem', { enabled: true, nextRunAt: origNext });
  await sched2.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(sideEffect, 1, 'restart does not re-run the same runId');
  await sched.stop();
  await sched2.stop();
});

// ── T3 ───────────────────────────────────────────────────────────────────
test('T3: C-level structurally unreachable (static + dynamic)', () => {
  const runnersDir = path.join(__dirname, 'learning-loop', 'jobs', 'runners');
  const banned = ['hermes-pending-admin', 'skillGovernance', 'skill-governance', 'apply_skill_with_snapshot', 'apply_pending'];
  let bad = 0;
  for (const f of fs.readdirSync(runnersDir)) {
    if (!f.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(runnersDir, f), 'utf8');
    for (const sym of banned) {
      const requireMatch = new RegExp("require\\s*\\(\\s*['\"][^'\"]*" + sym.replace(/[-]/g, '[-]') + "['\"]");
      if (requireMatch.test(text)) {
        console.log('    ! banned import "' + sym + '" in ' + f);
        bad += 1;
      }
    }
  }
  assert.strictEqual(bad, 0, 'runners/ has no banned imports');
  const data = freshData();
  const reg = makeReg(data);
  let caught = null;
  try { reg.register({ jobId: 'c-1', type: 'index-rebuild', level: 'C', intervalMs: 60_000 }); }
  catch (e) { caught = e; }
  assert.ok(caught && caught.code === REJECTION_CODES.LEVEL_FORBIDDEN, 'C-level rejected with LEVEL_FORBIDDEN');
  caught = null;
  try { reg.register({ jobId: 'b-no-budget', type: 'history-mining', level: 'B', intervalMs: 60_000 }); }
  catch (e) { caught = e; }
  assert.ok(caught && caught.code === REJECTION_CODES.BUDGET_REQUIRED, 'B without budget -> BUDGET_REQUIRED');
  caught = null;
  try { reg.register({ jobId: 'short', type: 'index-rebuild', level: 'A', intervalMs: 1000 }); }
  catch (e) { caught = e; }
  assert.ok(caught && caught.code === REJECTION_CODES.INTERVAL_TOO_SHORT, 'short interval -> INTERVAL_TOO_SHORT');
});

// ── T4 ───────────────────────────────────────────────────────────────────
testAsync('T4: child timeout / abort -> status=aborted', async () => {
  const data = freshData();
  const reg = makeReg(data);
  let aborted = 0;
  const runners = { 'index-rebuild': ({ abortSignal }) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ status: 'done', modelCalls: 0 }), 60_000);
    if (abortSignal) abortSignal.addEventListener('abort', () => { aborted += 1; clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  }) };
  const sched = makeSched({ registry: reg, runners, data, ownerId: 't4', tickMs: 60_000, settleMs: 500 });
  reg.register({ jobId: 'hang', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  const p = sched.runNow('hang');
  await new Promise((r) => setTimeout(r, 20));
  sched.abortJob('hang');
  const r = await p;
  assert.ok(r && r.ok, 'runNow returns');
  await new Promise((r) => setTimeout(r, 200));
  const runs = ls.listJobRuns(data, { jobId: 'hang' });
  assert.ok(runs.length === 1, 'one run record');
  assert.ok(runs[0].status === 'aborted' || runs[0].status === 'failed', 'run is aborted/failed (got: ' + runs[0].status + ')');
  assert.ok(aborted >= 1, 'abortSignal fired');
  await sched.stop();
});

// ── T5 ───────────────────────────────────────────────────────────────────
testAsync('T5: B-level budget — runner over limit -> BUDGET_EXHAUSTED', async () => {
  const data = freshData();
  const reg = makeReg(data);
  const overRunner = async () => ({ status: 'done', modelCalls: 5 });
  const sched = makeSched({ registry: reg, runners: { 'history-mining': overRunner }, data, ownerId: 't5', tickMs: 60_000 });
  reg.register({ jobId: 'b-budget', type: 'history-mining', level: 'B', intervalMs: 60_000, budgetModelCalls: 1 });
  reg.update('b-budget', { enabled: true, nextRunAt: Date.now() - 1 });
  await sched.runNow('b-budget');
  await new Promise((r) => setTimeout(r, 50));
  const runs = ls.listJobRuns(data, { jobId: 'b-budget' });
  assert.ok(runs.length === 1, 'one run record');
  const run = runs[0];
  assert.strictEqual(run.status, 'failed', 'status is failed');
  assert.strictEqual(run.errorCode, 'BUDGET_EXHAUSTED', 'errorCode is BUDGET_EXHAUSTED');
  assert.strictEqual(run.modelCalls, 1, 'modelCalls clamped to 1 (the budget), not 5');
  await sched.stop();
});

// ── T6 ───────────────────────────────────────────────────────────────────
testAsync('T6: disabled job does not run even when nextRunAt is past', async () => {
  const data = freshData();
  const reg = makeReg(data);
  let dispatched = 0;
  const runners = { 'index-rebuild': async () => { dispatched += 1; return { status: 'done', modelCalls: 0 }; } };
  const sched = makeSched({ registry: reg, runners, data, ownerId: 't6', tickMs: 60_000 });
  reg.register({ jobId: 'off', type: 'index-rebuild', level: 'A', intervalMs: 60_000, enabled: false });
  reg.update('off', { enabled: false, nextRunAt: Date.now() - 1 });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(dispatched, 0, 'no dispatch');
  assert.strictEqual(ls.listJobRuns(data, { jobId: 'off' }).length, 0, 'no run record');
  await sched.stop();
});

// ── T7 ───────────────────────────────────────────────────────────────────
testAsync('T7: cross-window lock stale preempt + cancel-then-purge order', async () => {
  const data = freshData();
  ls.setJobLock(data, { ownerId: 'old', acquiredAt: Date.now() - 120_000, heartbeatAt: Date.now() - 120_000 });
  const reg = makeReg(data);
  let lockCaptured = null;
  // Capture the lock immediately after _acquireLock to prove the preempt.
  const sched = makeSched({ registry: reg, runners: { 'index-rebuild': async () => {
    lockCaptured = ls.getJobLock(data);
    return { status: 'done', modelCalls: 0 };
  } }, data, ownerId: 't7-new', tickMs: 30_000 });
  reg.register({ jobId: 't7job', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  reg.update('t7job', { enabled: true, nextRunAt: Date.now() - 1 });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lockCaptured && lockCaptured.ownerId === 't7-new', 'stale lock preempted (captured during run): ' + JSON.stringify(lockCaptured));
  // Workspace purge order: abortJob BEFORE registry.remove.
  const wsData = freshData();
  const wsReg = makeReg(wsData);
  wsReg.register({ jobId: 'ws-1', type: 'index-rebuild', level: 'A', intervalMs: 60_000, scopeWorkspace: 'w1' });
  const calls = [];
  const wsSched = {
    abortJob: (jobId) => { calls.push(['abort', jobId]); return { aborted: 0 }; },
  };
  await purgeWorkspace({
    workspaceId: 'w1',
    scheduler: wsSched,
    registry: wsReg,
    state: wsData,
    learningState: ls,
    persist: async () => {},
    logger: () => {},
  });
  assert.deepStrictEqual(calls, [['abort', 'ws-1']], 'abortJob called once before remove');
  assert.ok(!wsReg.get('ws-1'), 'def removed');
  await sched.stop();
});

// ── T8 ───────────────────────────────────────────────────────────────────
testAsync('T8: dual-window simulation — only one tick dispatches', async () => {
  const data = freshData();
  const reg = makeReg(data);
  let aDispatched = 0;
  let bDispatched = 0;
  const runnersA = { 'index-rebuild': async () => { aDispatched += 1; return { status: 'done', modelCalls: 0 }; } };
  const runnersB = { 'index-rebuild': async () => { bDispatched += 1; return { status: 'done', modelCalls: 0 }; } };
  const sA = makeSched({ registry: reg, runners: runnersA, data, ownerId: 'winA', tickMs: 60_000 });
  const sB = makeSched({ registry: reg, runners: runnersB, data, ownerId: 'winB', tickMs: 60_000 });
  reg.register({ jobId: 'shared', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  reg.update('shared', { enabled: true, nextRunAt: Date.now() - 1 });
  await sA.tick();
  await sB.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(aDispatched, 1, 'A dispatched');
  assert.strictEqual(bDispatched, 0, 'B denied by lock');
  await sA.stop();
  await sB.stop();
});

// ── T9 ───────────────────────────────────────────────────────────────────
testAsync('T9: no resource leak — 100 ticks + 20 jobs, no growth', async () => {
  const data = freshData();
  const reg = makeReg(data);
  let dispatched = 0;
  const runners = { 'index-rebuild': async () => { dispatched += 1; return { status: 'done', modelCalls: 0 }; } };
  const sched = makeSched({ registry: reg, runners, data, ownerId: 't9', tickMs: 60_000 });
  for (let i = 0; i < 20; i++) {
    reg.register({ jobId: 'leak-' + i, type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
    reg.update('leak-' + i, { enabled: true, nextRunAt: Date.now() - 1 });
  }
  const before = process.getActiveResourcesInfo ? process.getActiveResourcesInfo().length : 0;
  for (let i = 0; i < 100; i++) {
    await sched.tick();
  }
  await new Promise((r) => setTimeout(r, 200));
  const after = process.getActiveResourcesInfo ? process.getActiveResourcesInfo().length : 0;
  assert.ok(Math.abs(after - before) <= 2, 'active resource count stable (before=' + before + ' after=' + after + ')');
  assert.ok(dispatched >= 1, 'at least one dispatch');
  assert.ok(dispatched <= 20, 'no more than 20 dispatches (idempotency): got ' + dispatched);
  await sched.stop();
});

// ── T10 ──────────────────────────────────────────────────────────────────
test('T10: log scrubbing — errorText never carries body, max 200', () => {
  const e1 = redactErrorText('SKILL_PENDING_BUSY: ~/.hermes/skills/x/SKILL.md busy');
  assert.strictEqual(e1, 'redacted:path', 'path redaction');
  const e2 = redactErrorText('body: ' + 'A'.repeat(500));
  assert.ok(e2.length <= 200, 'long body trimmed: ' + e2.length);
  const e3 = redactErrorText('normal error code RUNNER_THREW');
  assert.ok(e3.indexOf('RUNNER_THREW') >= 0, 'short code preserved');
  const e4 = redactErrorText('blob ' + 'A'.repeat(200));
  assert.strictEqual(e4, 'redacted:blob', 'long base64-like blob redacted');
  // Integration: real scheduler applies it.
  const data = freshData();
  const reg = makeReg(data);
  const runners = { 'index-rebuild': async () => {
    const e = new Error('~/.hermes/skills/foo/SKILL.md body: ' + 'X'.repeat(500));
    throw e;
  } };
  const sched = makeSched({ registry: reg, runners, data, ownerId: 't10', tickMs: 60_000 });
  reg.register({ jobId: 'redact', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  return sched.runNow('redact').then(() => new Promise((r) => setTimeout(r, 50))).then(() => {
    const runs = ls.listJobRuns(data, { jobId: 'redact' });
    assert.ok(runs.length === 1, 'one run');
    assert.ok(runs[0].errorText.length <= 200, 'errorText <= 200 (got: ' + runs[0].errorText.length + ')');
    assert.ok(runs[0].errorText.indexOf('SKILL.md') < 0, 'errorText has no SKILL.md path');
    return sched.stop();
  });
});

// ── T11 ──────────────────────────────────────────────────────────────────
testAsync('T11: 24h same errorCode -> single notification per job', async () => {
  const data = freshData();
  const reg = makeReg(data);
  let notifies = 0;
  const notify = async () => { notifies += 1; };
  const failRunner = async () => { const e = new Error('boom'); e.name = 'BOOM_ERR'; throw e; };
  const sched = makeSched({ registry: reg, runners: { 'index-rebuild': failRunner }, data, ownerId: 't11', tickMs: 60_000, notify });
  reg.register({ jobId: 'fail-a', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  reg.update('fail-a', { enabled: true, nextRunAt: Date.now() - 1 });
  await sched.runNow('fail-a');
  await new Promise((r) => setTimeout(r, 50));
  reg.register({ jobId: 'fail-b', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  reg.update('fail-b', { enabled: true, nextRunAt: Date.now() - 1 });
  await sched.runNow('fail-b');
  await new Promise((r) => setTimeout(r, 50));
  // Two distinct jobs each get their own notification (the dedupe key is
  // jobId+code+day, not a global 24h mute). This is the correct per-job
  // window: the user sees "fail-a failed" and "fail-b failed" once each.
  assert.strictEqual(notifies, 2, 'one notification per job, not global');
  // Same-job same-code repeat: clear the run record (so the next runNow is
  // not skipped by idempotency) and re-run. The dedupe key is unchanged,
  // so no new notification fires.
  for (const r of ls.listJobRuns(data, { jobId: 'fail-a' })) { r.status = 'done'; r.errorCode = ''; }
  reg.update('fail-a', { enabled: true, nextRunAt: Date.now() - 1 });
  await sched.runNow('fail-a');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(notifies, 2, 'same job+code in same 24h does not re-notify');
  await sched.stop();
});

// ── T12 ──────────────────────────────────────────────────────────────────
testAsync('T12: scopeWorkspace enforcement — scoped job skipped when wrong workspace', async () => {
  const data = freshData();
  const reg = makeReg(data);
  let dispatched = 0;
  const runners = { 'index-rebuild': async () => { dispatched += 1; return { status: 'done', modelCalls: 0 }; } };
  const sched = makeSched({ registry: reg, runners, data, ownerId: 't12', tickMs: 60_000, getActiveWorkspace: () => 'workspace-B' });
  reg.register({ jobId: 'scoped', type: 'index-rebuild', level: 'A', intervalMs: 60_000, scopeWorkspace: 'workspace-A' });
  reg.update('scoped', { enabled: true, nextRunAt: Date.now() - 1 });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(dispatched, 0, 'scoped job does NOT run in wrong workspace');
  sched.getActiveWorkspace = () => 'workspace-A';
  reg.update('scoped', { enabled: true, nextRunAt: Date.now() - 1 });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(dispatched, 1, 'scoped job runs in matching workspace');
  reg.register({ jobId: 'unscoped', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  sched.getActiveWorkspace = () => 'workspace-X';
  reg.update('unscoped', { enabled: true, nextRunAt: Date.now() - 1 });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(dispatched, 2, 'unscoped job runs regardless of workspace');
  await sched.stop();
});

// ── T13 ──────────────────────────────────────────────────────────────────
testAsync('T13: A-level interrupted run is retried on next tick (recovery re-run)', async () => {
  const data = freshData();
  const reg = makeReg(data);
  let attempts = 0;
  const runners = { 'index-rebuild': async () => { attempts += 1; return { status: 'done', modelCalls: 0 }; } };
  const sched = makeSched({ registry: reg, runners, data, ownerId: 't13', tickMs: 60_000 });
  reg.register({ jobId: 'retry', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  const origNext = Date.now() - 1;
  reg.update('retry', { enabled: true, nextRunAt: origNext });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(attempts, 1, 'first tick runs');
  for (const r of ls.listJobRuns(data, { jobId: 'retry' })) {
    if (r.status === 'running' || r.status === 'done') {
      r.status = 'interrupted';
      r.errorCode = 'INTERRUPTED_BY_RESTART';
    }
  }
  reg.update('retry', { enabled: true, nextRunAt: origNext });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(attempts, 2, 'A-level interrupted run is re-executed on next tick');
  const runs = ls.listJobRuns(data, { jobId: 'retry' });
  assert.strictEqual(runs.length, 1, 'one run record (interrupted was reused, not duplicated)');
  assert.strictEqual(runs[0].status, 'done', 'final status is done');
  assert.ok(runs[0].retryOf, 'retryOf is stamped');
  await sched.stop();
});

// ── T14 ──────────────────────────────────────────────────────────────────
testAsync('T14: runNow respects cross-window lock (LOCK_NOT_ACQUIRED)', async () => {
  // F2 (P1-3): the cross-window mutex is now the FS lockfile at
  // {lockDir}/trylo-jobs.lock. state.jobs.lock is an audit mirror.
  // We plant a fresh lockfile (simulating the other window) and
  // verify runNow is denied. Then we make the lockfile stale
  // (rewind mtime) and verify runNow preempts.
  const data = freshData();
  const reg = makeReg(data);
  let dispatched = 0;
  const runners = { 'index-rebuild': async () => { dispatched += 1; return { status: 'done', modelCalls: 0 }; } };
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-l6-t14-'));
  // Plant an active lockfile owned by "other-window" with a recent heartbeat.
  const lf = require('./learning-loop/jobs/lockfile');
  const now = Date.now();
  fs.writeFileSync(path.join(lockDir, 'trylo-jobs.lock'),
    JSON.stringify({ ownerId: 'other-window', acquiredAt: now, heartbeatAt: now }), 'utf8');
  const sched = makeSched({ registry: reg, runners, data, ownerId: 't14', tickMs: 60_000, staleMs: 60_000, lockDir });
  reg.register({ jobId: 'locked', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  const r = await sched.runNow('locked');
  assert.strictEqual(r.ok, false, 'runNow denied');
  assert.strictEqual(r.code, 'LOCK_NOT_ACQUIRED', 'error code is LOCK_NOT_ACQUIRED: ' + r.code);
  assert.strictEqual(dispatched, 0, 'no dispatch');
  // Now make the lockfile stale by rewriting with an old heartbeat.
  // The lockfile module reads heartbeatAt and preempts on stale.
  fs.writeFileSync(path.join(lockDir, 'trylo-jobs.lock'),
    JSON.stringify({ ownerId: 'other-window', acquiredAt: now - 120_000, heartbeatAt: now - 120_000 }), 'utf8');
  const r2 = await sched.runNow('locked');
  assert.strictEqual(r2.ok, true, 'runNow succeeds after lock goes stale');
  assert.strictEqual(dispatched, 1, 'dispatched after preempt');
  await sched.stop();
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
});

// ── T14-B ───────────────────────────────────────────────────────────────
testAsync('T14-B: cross-window tick — two independent schedulers, one lockfile', async () => {
  // F2: proves the lockfile is the real cross-window mutex. Two
  // scheduler instances have their OWN data blobs (no shared state)
  // but SHARE the same lockDir. Only one should dispatch.
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-l6-t14b-'));
  const dataA = freshData();
  const dataB = freshData();
  const regA = makeReg(dataA);
  const regB = makeReg(dataB);
  let dispatchedA = 0;
  let dispatchedB = 0;
  const runnersA = { 'index-rebuild': async () => { dispatchedA += 1; return { status: 'done', modelCalls: 0 }; } };
  const runnersB = { 'index-rebuild': async () => { dispatchedB += 1; return { status: 'done', modelCalls: 0 }; } };
  const sA = makeSched({ registry: regA, runners: runnersA, data: dataA, ownerId: 'winA', tickMs: 60_000, lockDir });
  const sB = makeSched({ registry: regB, runners: runnersB, data: dataB, ownerId: 'winB', tickMs: 60_000, lockDir });
  regA.register({ jobId: 'shared', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  regB.register({ jobId: 'shared', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  regA.update('shared', { enabled: true, nextRunAt: Date.now() - 1 });
  regB.update('shared', { enabled: true, nextRunAt: Date.now() - 1 });
  // A ticks first, acquires the lockfile
  await sA.tick();
  // While A still holds (no _releaseLock between A's tick and B's),
  // B tries and is denied
  await sB.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(dispatchedA, 1, 'A dispatched (owns lockfile)');
  assert.strictEqual(dispatchedB, 0, 'B denied by cross-window lockfile');
  await sA.stop();
  await sB.stop();
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
});

// ── T15 ──────────────────────────────────────────────────────────────────
testAsync('T15: history-mining runner reports actual model calls', async () => {
  const runner = require('./learning-loop/jobs/runners/history-mining.js');
  let callsToOrch = 0;
  const deps = {
    buildOrchestrator: () => ({
      runOnce: async () => {
        callsToOrch += 1;
        return { status: 'ok', candidates: [{ id: 'c1' }, { id: 'c2' }], errors: [{ code: 'E1' }] };
      },
    }),
    workspace: () => ({ label: 'job', path: '' }),
    currentTask: () => 'history-mining job',
  };
  const out = await runner.run({ job: { jobId: 'hm', type: 'history-mining', level: 'B', intervalMs: 60_000, budgetModelCalls: 3 }, run: { runId: 'hm:1' }, abortSignal: null, state: {}, deps });
  assert.strictEqual(out.status, 'done', 'done');
  assert.strictEqual(out.modelCalls, 3, 'modelCalls = candidates(2) + errors(1) = 3');
  assert.strictEqual(callsToOrch, 1, 'orchestrator called once');
});

// ── T16 ──────────────────────────────────────────────────────────────────
test('T16: _capJobRuns hard cap — protected runs older than 30d are evicted first', () => {
  const data = freshData();
  const jobs = ls.getJobs(data);
  const now = Date.now();
  const day = 86400 * 1000;
  // 500 interrupted: 250 fresh (1s old) + 250 old (60d old).
  for (let i = 0; i < 500; i++) {
    jobs.runs.push({
      runId: 'j:' + i,
      jobId: 'j',
      type: 'index-rebuild',
      level: 'A',
      startedAt: i < 250 ? now - 1000 : now - 60 * day,
      finishedAt: now,
      status: 'interrupted',
      modelCalls: 0, errorCode: '', errorText: '', artifacts: null,
    });
  }
  // Adding 1 more triggers the cap. evictCount = 501 - 500 = 1. The cap
  // prefers non-protected first (none), then protected-older-than-30d.
  // The 250 old (60d) are all >30d, so the single eviction should come
  // from the old set.
  ls.addJobRun(data, { runId: 'j:new', jobId: 'j', type: 'index-rebuild', level: 'A', startedAt: now, finishedAt: null, status: 'running', modelCalls: 0, errorCode: '', errorText: '', artifacts: null });
  const runs = ls.listJobRuns(data);
  assert.strictEqual(runs.length, 500, 'cap holds at 500');
  // The new run must be present.
  const hasNew = runs.some((r) => r.runId === 'j:new');
  assert.ok(hasNew, 'new run is included');
  // Exactly 1 of the old runs was evicted.
  const oldLeft = runs.filter((r) => Number(r.startedAt || 0) < now - 30 * day);
  assert.strictEqual(oldLeft.length, 249, '1 old protected run evicted (250 -> 249)');
  // All fresh runs are still present.
  const freshLeft = runs.filter((r) => Number(r.startedAt || 0) > now - 30 * day && r.runId !== 'j:new');
  assert.strictEqual(freshLeft.length, 250, 'all 250 fresh runs preserved');
});

// ── T15-A ────────────────────────────────────────────────────────────────
testAsync('T15-A: F3 — 3-fail consecutive requires ALL THREE failed, not just last 3', async () => {
  const data = freshData();
  const reg = makeReg(data);
  const failRunner = async () => { const e = new Error('boom'); e.name = 'BANG'; throw e; };
  const sched = makeSched({ registry: reg, runners: { 'index-rebuild': failRunner }, data, ownerId: 't15a', tickMs: 60_000 });
  reg.register({ jobId: 'three-fail', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  // Plant F,F,then a "done" run, then F. The 3 most recent are
  // F, done, F. The streak is BROKEN by 'done'.
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    ls.addJobRun(data, { runId: 'f' + i, jobId: 'three-fail', type: 'index-rebuild', level: 'A', startedAt: now - (10 - i) * 1000, finishedAt: now, status: 'failed', modelCalls: 0, errorCode: 'BANG', errorText: '', artifacts: null });
  }
  ls.addJobRun(data, { runId: 'ok1', jobId: 'three-fail', type: 'index-rebuild', level: 'A', startedAt: now - 100, finishedAt: now, status: 'done', modelCalls: 0, errorCode: '', errorText: '', artifacts: null });
  ls.addJobRun(data, { runId: 'lastf', jobId: 'three-fail', type: 'index-rebuild', level: 'A', startedAt: now - 50, finishedAt: now, status: 'failed', modelCalls: 0, errorCode: 'BANG', errorText: '', artifacts: null });
  // Manually trigger the dispatch path with a runner that throws
  // to invoke _maybeAutoDisable.
  await sched.runNow('three-fail');
  // The job is still enabled (not auto-disabled) because done broke the streak.
  const def = reg.get('three-fail');
  assert.strictEqual(def.enabled, true, 'A-level job NOT auto-disabled (done broke the streak)');
  // Now plant three consecutive FAILED runs and verify auto-disable fires.
  const data2 = freshData();
  const reg2 = makeReg(data2);
  const sched2 = makeSched({ registry: reg2, runners: { 'index-rebuild': failRunner }, data: data2, ownerId: 't15b', tickMs: 60_000 });
  reg2.register({ jobId: 'three-fail-2', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  for (let i = 0; i < 3; i++) {
    ls.addJobRun(data2, { runId: 'f2-' + i, jobId: 'three-fail-2', type: 'index-rebuild', level: 'A', startedAt: now - (10 - i) * 1000, finishedAt: now, status: 'failed', modelCalls: 0, errorCode: 'BANG', errorText: '', artifacts: null });
  }
  await sched2.runNow('three-fail-2');
  const def2 = reg2.get('three-fail-2');
  assert.strictEqual(def2.enabled, false, 'A-level job auto-disabled (3 consecutive failures)');
  await sched.stop();
  await sched2.stop();
});

// ── T16-A ────────────────────────────────────────────────────────────────
testAsync('T16-A: F4 — BUDGET_BLOCKED skips runner when previous run exhausted', async () => {
  const data = freshData();
  const reg = makeReg(data);
  let runnerCalls = 0;
  const budgetRunner = async () => { runnerCalls += 1; return { status: 'done', modelCalls: 5 }; };
  const sched = makeSched({ registry: reg, runners: { 'history-mining': budgetRunner }, data, ownerId: 't16a', tickMs: 60_000 });
  reg.register({ jobId: 'b-budget-block', type: 'history-mining', level: 'B', intervalMs: 60_000, budgetModelCalls: 1 });
  // First run: BUDGET_EXHAUSTED (post-check kicks in)
  await sched.runNow('b-budget-block');
  await new Promise((r) => setTimeout(r, 50));
  const calls1 = runnerCalls;
  assert.strictEqual(calls1, 1, 'first run invoked runner (to be blocked after)');
  // The previous run is BUDGET_EXHAUSTED — DON'T clear it; advance
  // nextRunAt to a fresh time so the new tick has a new runId
  // (idempotency) and the BUDGET_EXHAUSTED record is still last.
  reg.update('b-budget-block', { enabled: true, nextRunAt: Date.now() - 1 });
  await sched.runNow('b-budget-block');
  await new Promise((r) => setTimeout(r, 50));
  // F4 (P2-2): runner should NOT have been called for the BUDGET_BLOCKED run.
  const runs2 = ls.listJobRuns(data, { jobId: 'b-budget-block' });
  const blocked = runs2.find((r) => r.status === 'failed' && r.errorCode === 'BUDGET_BLOCKED');
  assert.ok(blocked, 'a BUDGET_BLOCKED run was recorded (runs: ' + JSON.stringify(runs2.map(r => ({s: r.status, e: r.errorCode}))) + ')');
  assert.strictEqual(runnerCalls, calls1, 'runner NOT called for BUDGET_BLOCKED (calls=' + runnerCalls + ', was=' + calls1 + ')');
  await sched.stop();
});

// ── T17-B ────────────────────────────────────────────────────────────────
testAsync('T17-B: F1 — B-level interrupted run is NOT auto-resumed', async () => {
  const data = freshData();
  const reg = makeReg(data);
  let dispatched = 0;
  const runners = { 'history-mining': async () => { dispatched += 1; return { status: 'done', modelCalls: 1 }; } };
  const sched = makeSched({ registry: reg, runners, data, ownerId: 't17b', tickMs: 60_000 });
  reg.register({ jobId: 'b-interrupted', type: 'history-mining', level: 'B', intervalMs: 60_000, budgetModelCalls: 3 });
  // Plant a 'running' run; mark as 'interrupted' (simulating recovery).
  const origNext = Date.now() - 1;
  ls.addJobRun(data, { runId: 'b-interrupted:' + origNext, jobId: 'b-interrupted', type: 'history-mining', level: 'B', startedAt: origNext, finishedAt: null, status: 'running', modelCalls: 0, errorCode: '', errorText: '', artifacts: null });
  for (const r of ls.listJobRuns(data, { jobId: 'b-interrupted' })) {
    if (r.status === 'running') { r.status = 'interrupted'; r.errorCode = 'INTERRUPTED_BY_RESTART'; }
  }
  reg.update('b-interrupted', { enabled: true, nextRunAt: origNext });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 30));
  // F1: B-level interrupted MUST NOT auto-resume.
  assert.strictEqual(dispatched, 0, 'B-level interrupted NOT auto-resumed');
  // The run record is still 'interrupted' (preserved for audit).
  const runs = ls.listJobRuns(data, { jobId: 'b-interrupted' });
  assert.ok(runs.length === 1 && runs[0].status === 'interrupted', 'run record stays interrupted');
  // runNow should still work (user override).
  await sched.runNow('b-interrupted');
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(dispatched, 1, 'B-level runNow works (user explicit)');
  await sched.stop();
});

// ── T18 ──────────────────────────────────────────────────────────────────
testAsync('T18: F2-v2 — lockfile released on stop()', async () => {
  // v2-audit fix: _releaseLockfile was defined but never called.
  // The lockfile accumulated on disk per activate. Now stop() releases
  // it; this test asserts no leftover file after stop().
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-l6-t18-'));
  const data = freshData();
  const reg = makeReg(data);
  reg.register({ jobId: 'j18', type: 'index-rebuild', level: 'A', intervalMs: 60_000 });
  reg.update('j18', { enabled: true, nextRunAt: Date.now() - 1 });
  const sched = makeSched({
    registry: reg, runners: { 'index-rebuild': async () => ({ status: 'done', modelCalls: 0 }) },
    data, ownerId: 't18', tickMs: 60_000, lockDir,
  });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 50));
  await sched.stop();
  await new Promise((r) => setTimeout(r, 100));
  // After stop(), the lockfile should be cleaned up.
  const remaining = fs.readdirSync(lockDir).filter((f) => f === 'trylo-jobs.lock');
  assert.strictEqual(remaining.length, 0, 'lockfile released on stop; remaining: ' + JSON.stringify(remaining));
  fs.rmSync(lockDir, { recursive: true, force: true });
});

(async () => {
  console.log('--- L6 smoke ---');
  await Promise.all(asyncPending);
  console.log('\n--- Summary ---');
  console.log('  Passed: ' + passed);
  console.log('  Failed: ' + failed);
  if (failed > 0) {
    console.log('  Failures:');
    for (const f of failures) console.log('    - ' + f);
    process.exit(1);
  }
  if (process.argv.includes('--self-test-fail')) process.exit(1);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

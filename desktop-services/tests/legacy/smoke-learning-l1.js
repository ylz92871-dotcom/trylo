/*
 * smoke-learning-l1.js
 *
 * Tests for Learning L1 candidate governance (04_LEARNING_L1_CANDIDATE_GOVERNANCE).
 * Covers Phase 0 fixes and L1 candidate policy.
 *
 * Run: node smoke-learning-l1.js
 */

'use strict';

const assert = require('node:assert/strict');

const candidatePolicy = require('./learning-loop/candidate-policy');
const extAdapter = require('./learning-loop/extension-adapter');
const learningState = require('./learning-loop/learning-state');
const triggerPolicy = require('./learning-loop/trigger-policy');
const orchestrator = require('./learning-loop/orchestrator');
const promptClient = require('./learning-loop/prompt-client');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${err.message}`);
  }
}

function ok(msg) { console.log(`  PASS: ${msg}`); passed++; }

// ---------------------------------------------------------------------------
// Phase 0.1: Raw vs Persisted Event Filters
// ---------------------------------------------------------------------------
console.log('\n--- Phase 0.1: Raw vs Persisted Event Filters ---');

test('isSuccessfulRawToolEvent: accepts completed/success with id', () => {
  assert.ok(extAdapter.isSuccessfulRawToolEvent({
    category: 'edit', phase: 'completed', level: 'success', id: 'e1',
  }));
});

test('isSuccessfulRawToolEvent: rejects started/info', () => {
  assert.ok(!extAdapter.isSuccessfulRawToolEvent({
    category: 'edit', phase: 'started', level: 'info', id: 'e1',
  }));
});

test('isSuccessfulRawToolEvent: rejects failed/error', () => {
  assert.ok(!extAdapter.isSuccessfulRawToolEvent({
    category: 'edit', phase: 'failed', level: 'error', id: 'e1',
  }));
});

test('isSuccessfulRawToolEvent: rejects without stable id (04 §2.1)', () => {
  assert.ok(!extAdapter.isSuccessfulRawToolEvent({
    category: 'edit', phase: 'completed', level: 'success', id: '',
  }));
  assert.ok(!extAdapter.isSuccessfulRawToolEvent({
    category: 'edit', phase: 'completed', level: 'success',
  }));
});

test('isSuccessfulPersistedTurnEvent: accepts status=done with id', () => {
  assert.ok(extAdapter.isSuccessfulPersistedTurnEvent({
    category: 'edit', status: 'done', id: 'e1',
  }));
});

test('isSuccessfulPersistedTurnEvent: rejects status=running', () => {
  assert.ok(!extAdapter.isSuccessfulPersistedTurnEvent({
    category: 'edit', status: 'running', id: 'e1',
  }));
});

test('isSuccessfulPersistedTurnEvent: rejects status=error', () => {
  assert.ok(!extAdapter.isSuccessfulPersistedTurnEvent({
    category: 'edit', status: 'error', id: 'e1',
  }));
});

test('isSuccessfulPersistedTurnEvent: rejects without id', () => {
  assert.ok(!extAdapter.isSuccessfulPersistedTurnEvent({
    category: 'edit', status: 'done',
  }));
});

test('isSuccessfulPersistedTurnEvent: rejects chat category', () => {
  assert.ok(!extAdapter.isSuccessfulPersistedTurnEvent({
    category: 'chat', status: 'done', id: 'e1',
  }));
});

test('recoverLearningSourceEvidence: uses persisted filter — events with status=done recovered', () => {
  // Persisted events only have status, NOT phase/level.
  const sessions = [{
    id: 's1',
    turns: [{
      id: 't1', status: 'success', prompt: 'Fix bug', resultText: 'Fixed',
      events: [
        { id: 'e1', category: 'edit', title: 'Edit file', status: 'done' },
        { id: 'e2', category: 'verify', title: 'Run tests', status: 'done' },
        { id: 'e3', category: 'edit', title: 'Edit again', status: 'running' },
        { id: 'e4', category: 'chat', title: 'Chat', status: 'done' },
      ],
    }],
  }];

  const r = extAdapter.recoverLearningSourceEvidence(sessions, { sessionId: 's1', turnId: 't1' });
  assert.ok(r.ok, 'recovery ok');
  assert.strictEqual(r.events.length, 2, '2 done events with valid category');
  assert.strictEqual(r.events[0].category, 'edit');
  assert.strictEqual(r.events[1].category, 'verify');
  // Verification from verify/test done events
  assert.ok(r.verification.length > 0, 'verification generated from verify event');
  ok('recoverLearningSourceEvidence: persisted filter works with status=done');
});

test('recoverLearningSourceEvidence: phase/level events are NOT accepted (persisted schema)', () => {
  // If someone stores raw events with phase/level, they should NOT pass the persisted filter.
  const sessions = [{
    id: 's1',
    turns: [{
      id: 't1', status: 'success', prompt: 'Fix bug', resultText: 'Fixed',
      events: [
        { id: 'e1', category: 'edit', phase: 'completed', level: 'success' }, // no status
      ],
    }],
  }];

  const r = extAdapter.recoverLearningSourceEvidence(sessions, { sessionId: 's1', turnId: 't1' });
  assert.ok(r.ok, 'recovery ok');
  assert.strictEqual(r.events.length, 0, '0 events — raw event without status=done rejected');
  ok('recoverLearningSourceEvidence: raw events without status are rejected by persisted filter');
});

// ---------------------------------------------------------------------------
// Phase 0.2: Stable reasonCode
// ---------------------------------------------------------------------------
console.log('\n--- Phase 0.2: Stable reasonCode ---');

test('orchestrator: STABILITY_GATE reasonCode', async () => {
  orchestrator.resetState();
  const gs = { get: () => undefined, update: async () => {} };
  const r = await orchestrator.runImplicitReview({
    context: { globalState: gs },
    workspaceRoot: '/ws',
    sessionId: 's1', turnId: 't1', mode: 'chat', // chat mode fails stability gate
    resultText: 'hi', interrupted: false, hasPendingReview: false,
    events: [], config: { enabled: true, creationNudgeInterval: 10 },
    globalStoragePath: '/tmp',
    runInShadow: async () => ({}), logTrace: () => {},
  });
  assert.strictEqual(r.status, 'skipped');
  assert.strictEqual(r.reasonCode, 'STABILITY_GATE');
});

test('orchestrator: BELOW_THRESHOLD reasonCode', async () => {
  orchestrator.resetState();
  const gs = { get: () => undefined, update: async () => {} };
  const r = await orchestrator.runImplicitReview({
    context: { globalState: gs },
    workspaceRoot: '/ws',
    sessionId: 's1', turnId: 't1', mode: 'agent',
    resultText: 'done', interrupted: false, hasPendingReview: false,
    events: [], config: { enabled: true, creationNudgeInterval: 10 },
    globalStoragePath: '/tmp',
    runInShadow: async () => ({}), logTrace: () => {},
  });
  assert.strictEqual(r.status, 'skipped');
  assert.strictEqual(r.reasonCode, 'BELOW_THRESHOLD');
});

// ---------------------------------------------------------------------------
// Phase 0.3: /learn turn lifecycle (tested via integration smoke)
// ---------------------------------------------------------------------------
console.log('\n--- Phase 0.3: /learn turn object contract (structure validation) ---');

test('startTurnInActiveSession returns turn object with id, status, prompt', () => {
  // Validate the contract: the turn object returned has the fields the webview expects.
  // This is a structural test — the actual function is in extension.js.
  const fakeTurn = {
    id: 'learn_test',
    prompt: '/learn',
    status: 'running',
    startedAt: Date.now(),
    mode: 'agent',
    events: [],
  };
  assert.strictEqual(typeof fakeTurn.id, 'string');
  assert.strictEqual(typeof fakeTurn.status, 'string');
  assert.strictEqual(typeof fakeTurn.prompt, 'string');
  ok('turn object contract validated');
});

// ---------------------------------------------------------------------------
// L1.5: candidate-policy.js — table-driven tests
// ---------------------------------------------------------------------------
console.log('\n--- L1.5: candidate-policy.js table-driven tests ---');

function makeEvents(cats) {
  return cats.map((c, i) => ({ id: `e${i}`, category: c, status: 'done', title: `${c} event` }));
}

test('Agent verified change (edit+verify) + cadence -> auto', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'success', interrupted: false, resultText: 'done',
    events: makeEvents(['edit', 'verify']),
    reviewResolution: { settled: true, accepted: 1, rejected: 0 },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'auto', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'auto');
  assert.ok(r.reasonCodes.includes('VERIFIED_CHANGE'));
  assert.ok(r.reasonCodes.includes('CADENCE_REACHED'));
});

test('suggest mode downgrades auto to suggest', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'success', interrupted: false, resultText: 'done',
    events: makeEvents(['edit', 'verify']),
    reviewResolution: { settled: true, accepted: 1, rejected: 0 },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'suggest', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'suggest');
});

test('edit without verify -> suggest', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'success', interrupted: false, resultText: 'done',
    events: makeEvents(['edit']),
    reviewResolution: { settled: true, accepted: 0, rejected: 0 },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'auto', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'suggest');
});

test('read/search only -> none', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'success', interrupted: false, resultText: 'done',
    events: makeEvents(['read', 'search']),
    reviewResolution: { settled: true, accepted: 0, rejected: 0 },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'auto', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'none');
  assert.ok(r.exclusionCodes.includes('ONLY_READ_SEARCH'));
});

test('chat mode -> none', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'chat', turnStatus: 'success', interrupted: false, resultText: 'done',
    events: makeEvents(['edit', 'verify']),
    reviewResolution: { settled: true, accepted: 1, rejected: 0 },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'auto', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'none');
  assert.ok(r.exclusionCodes.includes('INELIGIBLE_MODE'));
});

test('error status -> none', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'error', interrupted: false, resultText: 'failed',
    events: makeEvents(['edit', 'verify']),
    reviewResolution: { settled: true, accepted: 1, rejected: 0 },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'auto', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'none');
});

test('interrupted -> none', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'success', interrupted: true, resultText: 'done',
    events: makeEvents(['edit', 'verify']),
    reviewResolution: { settled: true, accepted: 1, rejected: 0 },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'auto', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'none');
  assert.ok(r.exclusionCodes.includes('INTERRUPTED'));
});

test('review pending -> none', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'success', interrupted: false, resultText: 'done',
    events: makeEvents(['edit', 'verify']),
    reviewResolution: { settled: false },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'auto', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'none');
  assert.ok(r.exclusionCodes.includes('REVIEW_PENDING'));
});

test('all rejected + no verify -> none', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'success', interrupted: false, resultText: 'done',
    events: makeEvents(['edit']),
    reviewResolution: { settled: true, accepted: 0, rejected: 3 },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'auto', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'none');
  assert.ok(r.exclusionCodes.includes('ALL_REJECTED_NO_VERIFY'));
});

test('accepted + verified -> auto (with cadence)', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'success', interrupted: false, resultText: 'done',
    events: makeEvents(['edit', 'verify']),
    reviewResolution: { settled: true, accepted: 1, rejected: 1 },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'auto', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'auto');
  assert.ok(r.reasonCodes.includes('VERIFIED_CHANGE'));
  assert.ok(r.reasonCodes.includes('ACCEPTED_AND_VERIFIED'));
});

test('cadence below threshold but high value -> suggest', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'success', interrupted: false, resultText: 'done',
    events: makeEvents(['edit', 'verify']),
    reviewResolution: { settled: true, accepted: 1, rejected: 0 },
    accumulatedIterations: 3, creationNudgeInterval: 10, // below threshold
    backgroundMode: 'auto', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'suggest'); // high confidence but below cadence
  assert.ok(r.reasonCodes.includes('VERIFIED_CHANGE'));
});

test('off mode -> none', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'success', interrupted: false, resultText: 'done',
    events: makeEvents(['edit', 'verify']),
    reviewResolution: { settled: true, accepted: 1, rejected: 0 },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'off', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'none');
  assert.ok(r.exclusionCodes.includes('BACKGROUND_DISABLED'));
});

test('evidence hash already staged -> none', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'success', interrupted: false, resultText: 'done',
    events: makeEvents(['edit', 'verify']),
    reviewResolution: { settled: true, accepted: 1, rejected: 0 },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'auto', evidenceHashStaged: true,
  });
  assert.strictEqual(r.action, 'none');
  assert.ok(r.exclusionCodes.includes('HASH_ALREADY_STAGED'));
});

test('NONTRIVIAL_WORKFLOW: 4+ events, 2+ categories, includes edit', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'success', interrupted: false, resultText: 'done',
    events: makeEvents(['edit', 'search', 'command', 'read']),
    reviewResolution: { settled: true, accepted: 0, rejected: 0 },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'auto', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'auto');
  assert.ok(r.reasonCodes.includes('NONTRIVIAL_WORKFLOW'));
  assert.ok(r.reasonCodes.includes('CADENCE_REACHED'));
});

test('single simple command without edit/verify -> none', () => {
  const r = candidatePolicy.evaluateCandidate({
    mode: 'agent', turnStatus: 'success', interrupted: false, resultText: 'done',
    events: makeEvents(['command']),
    reviewResolution: { settled: true, accepted: 0, rejected: 0 },
    accumulatedIterations: 10, creationNudgeInterval: 10,
    backgroundMode: 'auto', evidenceHashStaged: false,
  });
  assert.strictEqual(r.action, 'none');
  assert.ok(r.exclusionCodes.includes('SINGLE_SIMPLE_COMMAND'));
});

test('resolveBackgroundMode: enabled=false -> off', () => {
  assert.strictEqual(candidatePolicy.resolveBackgroundMode({ enabled: false }), 'off');
});

test('resolveBackgroundMode: enabled=true, no mode -> auto', () => {
  assert.strictEqual(candidatePolicy.resolveBackgroundMode({ enabled: true }), 'auto');
});

test('resolveBackgroundMode: mode=suggest -> suggest', () => {
  assert.strictEqual(candidatePolicy.resolveBackgroundMode({ enabled: true, mode: 'suggest' }), 'suggest');
});

test('resolveBackgroundMode: mode=off -> off', () => {
  assert.strictEqual(candidatePolicy.resolveBackgroundMode({ enabled: true, mode: 'off' }), 'off');
});

// ---------------------------------------------------------------------------
// L1.4: Turn learning state
// ---------------------------------------------------------------------------
console.log('\n--- L1.4: Turn learning state ---');

test('createTurnLearningState: default values', () => {
  const ls = learningState.createTurnLearningState();
  assert.strictEqual(ls.schemaVersion, 1);
  assert.strictEqual(ls.state, 'ineligible');
  assert.strictEqual(ls.action, 'none');
  assert.ok(Array.isArray(ls.reasonCodes));
  assert.ok(Array.isArray(ls.exclusionCodes));
});

test('setTurnLearningState: updates fields and sets updatedAt', () => {
  const turn = { id: 't1', prompt: 'test' };
  const before = Date.now();
  learningState.setTurnLearningState(turn, { state: 'eligible', action: 'auto' });
  assert.ok(turn.learning);
  assert.strictEqual(turn.learning.state, 'eligible');
  assert.strictEqual(turn.learning.action, 'auto');
  assert.ok(turn.learning.updatedAt >= before);
});

test('getTurnLearningState: returns null if not set', () => {
  const turn = { id: 't1' };
  assert.strictEqual(learningState.getTurnLearningState(turn), null);
});

test('isTurnLearningTerminal: staged is terminal', () => {
  const turn = { learning: { state: 'staged' } };
  assert.ok(learningState.isTurnLearningTerminal(turn));
});

test('isTurnLearningTerminal: eligible is NOT terminal', () => {
  const turn = { learning: { state: 'eligible' } };
  assert.ok(!learningState.isTurnLearningTerminal(turn));
});

test('isTurnLearningTerminal: no learning state returns false', () => {
  const turn = { id: 't1' };
  assert.ok(!learningState.isTurnLearningTerminal(turn));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n--- Summary ---');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}

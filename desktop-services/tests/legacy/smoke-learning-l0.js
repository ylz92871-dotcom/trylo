/*
 * smoke-learning-l0.js
 *
 * Narrow tests for Learning L0 pure modules and the prompt adapter.
 * Does NOT require the full VS Code extension to be running.
 *
 * Run: npm run smoke:learning-l0
 */

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveHermesPython } = require('./hermes-python-resolver');

const triggerPolicy = require('./learning-loop/trigger-policy');
const evidenceBuilder = require('./learning-loop/evidence-builder');

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

// ---------------------------------------------------------------------------
// 1. trigger-policy.js
// ---------------------------------------------------------------------------
console.log('\n--- trigger-policy.js ---');

test('isMeaningfulToolIteration: valid search event', () => {
  assert.ok(triggerPolicy.isMeaningfulToolIteration({ category: 'search', status: 'done' }));
});

test('isMeaningfulToolIteration: valid edit event', () => {
  assert.ok(triggerPolicy.isMeaningfulToolIteration({ category: 'edit', status: 'done' }));
});

test('isMeaningfulToolIteration: valid verify event', () => {
  assert.ok(triggerPolicy.isMeaningfulToolIteration({ category: 'verify', status: 'passed' }));
});

test('isMeaningfulToolIteration: rejects chat event', () => {
  assert.ok(!triggerPolicy.isMeaningfulToolIteration({ category: 'chat', status: 'done' }));
});

test('isMeaningfulToolIteration: rejects failed event', () => {
  assert.ok(!triggerPolicy.isMeaningfulToolIteration({ category: 'search', status: 'failed' }));
});

test('isMeaningfulToolIteration: rejects null', () => {
  assert.ok(!triggerPolicy.isMeaningfulToolIteration(null));
});

test('isMeaningfulToolIteration: rejects undefined', () => {
  assert.ok(!triggerPolicy.isMeaningfulToolIteration(undefined));
});

test('countMeaningfulIterations: counts correctly', () => {
  const events = [
    { category: 'search', status: 'done' },
    { category: 'edit', status: 'done' },
    { category: 'chat', status: 'done' },
    { category: 'verify', status: 'passed' },
    { category: 'search', status: 'failed' },
  ];
  assert.equal(triggerPolicy.countMeaningfulIterations(events), 3);
});

test('countMeaningfulIterations: empty array returns 0', () => {
  assert.equal(triggerPolicy.countMeaningfulIterations([]), 0);
});

test('countMeaningfulIterations: non-array returns 0', () => {
  assert.equal(triggerPolicy.countMeaningfulIterations(null), 0);
});

test('isStableTaskTurn: success agent turn', () => {
  assert.ok(triggerPolicy.isStableTaskTurn({
    status: 'success',
    mode: 'agent',
    resultText: 'Done.',
    interrupted: false,
    hasPendingReview: false,
  }));
});

test('isStableTaskTurn: success office turn', () => {
  assert.ok(triggerPolicy.isStableTaskTurn({
    status: 'success',
    mode: 'office',
    resultText: 'Report generated.',
    interrupted: false,
    hasPendingReview: false,
  }));
});

test('isStableTaskTurn: rejects chat mode', () => {
  assert.ok(!triggerPolicy.isStableTaskTurn({
    status: 'success',
    mode: 'chat',
    resultText: 'Hello.',
    interrupted: false,
    hasPendingReview: false,
  }));
});

test('isStableTaskTurn: rejects plan mode', () => {
  assert.ok(!triggerPolicy.isStableTaskTurn({
    status: 'success',
    mode: 'plan',
    resultText: 'Plan created.',
    interrupted: false,
    hasPendingReview: false,
  }));
});

test('isStableTaskTurn: rejects error status', () => {
  assert.ok(!triggerPolicy.isStableTaskTurn({
    status: 'error',
    mode: 'agent',
    resultText: 'Something failed.',
    interrupted: false,
    hasPendingReview: false,
  }));
});

test('isStableTaskTurn: rejects stopped', () => {
  assert.ok(!triggerPolicy.isStableTaskTurn({
    status: 'stopped',
    mode: 'agent',
    resultText: 'Stopped.',
    interrupted: false,
    hasPendingReview: false,
  }));
});

test('isStableTaskTurn: rejects interrupted', () => {
  assert.ok(!triggerPolicy.isStableTaskTurn({
    status: 'success',
    mode: 'agent',
    resultText: 'Done.',
    interrupted: true,
    hasPendingReview: false,
  }));
});

test('isStableTaskTurn: rejects pending review', () => {
  assert.ok(!triggerPolicy.isStableTaskTurn({
    status: 'success',
    mode: 'agent',
    resultText: 'Done.',
    interrupted: false,
    hasPendingReview: true,
  }));
});

test('isStableTaskTurn: rejects empty result', () => {
  assert.ok(!triggerPolicy.isStableTaskTurn({
    status: 'success',
    mode: 'agent',
    resultText: '',
    interrupted: false,
    hasPendingReview: false,
  }));
});

test('checkTrigger: below threshold', () => {
  const result = triggerPolicy.checkTrigger({
    meaningfulIterations: 5,
    creationNudgeInterval: 10,
    enabled: true,
    evidenceHash: 'sha256:abc',
    processedHashes: new Set(),
    learningRunActive: false,
  });
  assert.ok(!result.triggered);
  assert.ok(result.reason.includes('5'));
});

test('checkTrigger: at threshold triggers', () => {
  const result = triggerPolicy.checkTrigger({
    meaningfulIterations: 10,
    creationNudgeInterval: 10,
    enabled: true,
    evidenceHash: 'sha256:def',
    processedHashes: new Set(),
    learningRunActive: false,
  });
  assert.ok(result.triggered);
});

test('checkTrigger: above threshold triggers', () => {
  const result = triggerPolicy.checkTrigger({
    meaningfulIterations: 12,
    creationNudgeInterval: 10,
    enabled: true,
    evidenceHash: 'sha256:ghi',
    processedHashes: new Set(),
    learningRunActive: false,
  });
  assert.ok(result.triggered);
});

test('checkTrigger: disabled skips', () => {
  const result = triggerPolicy.checkTrigger({
    meaningfulIterations: 15,
    creationNudgeInterval: 10,
    enabled: false,
    evidenceHash: 'sha256:jkl',
    processedHashes: new Set(),
    learningRunActive: false,
  });
  assert.ok(!result.triggered);
  assert.ok(result.reason.includes('enabled is false'));
});

test('checkTrigger: idempotency gate blocks duplicate', () => {
  const hashes = new Set(['sha256:abc']);
  const result = triggerPolicy.checkTrigger({
    meaningfulIterations: 15,
    creationNudgeInterval: 10,
    enabled: true,
    evidenceHash: 'sha256:abc',
    processedHashes: hashes,
    learningRunActive: false,
  });
  assert.ok(!result.triggered);
  assert.ok(result.reason.includes('idempotency'));
});

test('checkTrigger: single-flight lock blocks', () => {
  const result = triggerPolicy.checkTrigger({
    meaningfulIterations: 15,
    creationNudgeInterval: 10,
    enabled: true,
    evidenceHash: 'sha256:new',
    processedHashes: new Set(),
    learningRunActive: true,
  });
  assert.ok(!result.triggered);
  assert.ok(result.reason.includes('already active'));
});

test('checkExplicitLearn: allowed in agent mode', () => {
  const result = triggerPolicy.checkExplicitLearn({
    mode: 'agent',
    agentRunning: false,
    hasPendingReview: false,
    evidenceHash: 'sha256:xyz',
    processedHashes: new Set(),
  });
  assert.ok(result.allowed);
});

test('checkExplicitLearn: rejects chat mode', () => {
  const result = triggerPolicy.checkExplicitLearn({
    mode: 'chat',
    agentRunning: false,
    hasPendingReview: false,
    evidenceHash: 'sha256:xyz',
    processedHashes: new Set(),
  });
  assert.ok(!result.allowed);
});

test('checkExplicitLearn: rejects when agent running', () => {
  const result = triggerPolicy.checkExplicitLearn({
    mode: 'agent',
    agentRunning: true,
    hasPendingReview: false,
    evidenceHash: 'sha256:xyz',
    processedHashes: new Set(),
  });
  assert.ok(!result.allowed);
});

test('checkExplicitLearn: rejects pending review', () => {
  const result = triggerPolicy.checkExplicitLearn({
    mode: 'agent',
    agentRunning: false,
    hasPendingReview: true,
    evidenceHash: 'sha256:xyz',
    processedHashes: new Set(),
  });
  assert.ok(!result.allowed);
});

test('checkExplicitLearn: idempotency gate', () => {
  const result = triggerPolicy.checkExplicitLearn({
    mode: 'agent',
    agentRunning: false,
    hasPendingReview: false,
    evidenceHash: 'sha256:dup',
    processedHashes: new Set(['sha256:dup']),
  });
  assert.ok(!result.allowed);
});

test('clampInterval: clamps to min', () => {
  assert.equal(triggerPolicy.clampInterval(3), 5);
});

test('clampInterval: clamps to max', () => {
  assert.equal(triggerPolicy.clampInterval(200), 100);
});

test('clampInterval: keeps valid value', () => {
  assert.equal(triggerPolicy.clampInterval(20), 20);
});

test('clampInterval: defaults invalid input', () => {
  assert.equal(triggerPolicy.clampInterval(NaN), 10);
});

// ---------------------------------------------------------------------------
// 2. evidence-builder.js
// ---------------------------------------------------------------------------
console.log('\n--- evidence-builder.js ---');

test('buildEvidenceCapsule: basic structure', () => {
  const { capsule, evidenceHash, charCount } = evidenceBuilder.buildEvidenceCapsule({
    sessionId: 'sess-1',
    turnId: 'turn-1',
    workspaceHint: 'my-repo',
    triggerKind: 'implicit',
    toolIterations: 12,
    events: [
      { category: 'search', title: 'Searched for config', status: 'done' },
      { category: 'edit', title: 'Edited main.js', status: 'done' },
      { category: 'verify', title: 'npm test', status: 'passed' },
    ],
    fileHints: ['src/main.js', 'package.json'],
    verification: ['npm test: passed'],
    resultSummary: 'Fixed the config loading issue.',
  });

  assert.equal(capsule.schemaVersion, 1);
  assert.equal(capsule.trigger.kind, 'implicit');
  assert.equal(capsule.trigger.toolIterations, 12);
  assert.equal(capsule.source.sessionId, 'sess-1');
  assert.equal(capsule.source.turnId, 'turn-1');
  assert.equal(capsule.workflow.length, 3);
  assert.equal(capsule.fileHints.length, 2);
  assert.equal(capsule.verification.length, 1);
  assert.ok(capsule.resultSummary);
  assert.ok(typeof evidenceHash === 'string');
  assert.ok(evidenceHash.startsWith('sha256:'));
  assert.ok(charCount > 0);
});

test('buildEvidenceCapsule: no rawMessages or reasoning', () => {
  const { capsule } = evidenceBuilder.buildEvidenceCapsule({
    sessionId: 'sess-1',
    turnId: 'turn-1',
    events: [],
  });

  const json = JSON.stringify(capsule);
  assert.ok(!json.includes('rawMessages'));
  assert.ok(!json.includes('reasoning'));
  assert.ok(!json.includes('chain-of-thought'));
});

test('buildEvidenceCapsule: strips shadow/temp paths', () => {
  const { capsule } = evidenceBuilder.buildEvidenceCapsule({
    sessionId: 'sess-1',
    turnId: 'turn-1',
    fileHints: [
      'src/main.js',
      '/tmp/shadow-review-abc/workspace/config.json',
      'C:\\temp\\shadow-x\\file.txt',
      'package.json',
    ],
    events: [],
  });

  assert.equal(capsule.fileHints.length, 2);
  assert.ok(capsule.fileHints.includes('src/main.js'));
  assert.ok(capsule.fileHints.includes('package.json'));
  assert.ok(!capsule.fileHints.some(f => f.includes('shadow')));
});

test('buildEvidenceCapsule: strips API keys', () => {
  const { capsule } = evidenceBuilder.buildEvidenceCapsule({
    sessionId: 'sess-1',
    turnId: 'turn-1',
    resultSummary: 'Used API key sk-abcdef1234567890abcdef1234567890 for the request.',
    events: [],
  });

  const json = JSON.stringify(capsule);
  assert.ok(!json.includes('sk-abcdef1234567890abcdef1234567890'));
  assert.ok(json.includes('[REDACTED]'));
});

test('buildEvidenceCapsule: enforces workflow max 24', () => {
  const events = [];
  for (let i = 0; i < 50; i++) {
    events.push({ category: 'search', title: `Event ${i}`, status: 'done' });
  }
  const { capsule } = evidenceBuilder.buildEvidenceCapsule({
    sessionId: 'sess-1',
    turnId: 'turn-1',
    events,
  });

  assert.ok(capsule.workflow.length <= 24);
});

test('buildEvidenceCapsule: enforces fileHints max 40', () => {
  const hints = [];
  for (let i = 0; i < 60; i++) {
    hints.push(`src/file-${i}.js`);
  }
  const { capsule } = evidenceBuilder.buildEvidenceCapsule({
    sessionId: 'sess-1',
    turnId: 'turn-1',
    fileHints: hints,
    events: [],
  });

  assert.ok(capsule.fileHints.length <= 40);
});

test('buildEvidenceCapsule: max chars enforced', () => {
  const events = [];
  for (let i = 0; i < 30; i++) {
    events.push({
      category: 'search',
      title: 'A'.repeat(250),
      status: 'done',
    });
  }
  const { capsule, charCount } = evidenceBuilder.buildEvidenceCapsule({
    sessionId: 'sess-1',
    turnId: 'turn-1',
    events,
  });

  assert.ok(charCount <= 12000);
  // Must be valid JSON
  JSON.parse(JSON.stringify(capsule));
});

test('buildEvidenceCapsule: different inputs produce different hashes', () => {
  const a = evidenceBuilder.buildEvidenceCapsule({
    sessionId: 'sess-a',
    turnId: 'turn-1',
    events: [{ category: 'search', status: 'done' }],
  });
  const b = evidenceBuilder.buildEvidenceCapsule({
    sessionId: 'sess-b',
    turnId: 'turn-1',
    events: [{ category: 'search', status: 'done' }],
  });

  assert.notEqual(a.evidenceHash, b.evidenceHash);
});

test('buildEvidenceCapsule: same inputs produce same hash', () => {
  const a = evidenceBuilder.buildEvidenceCapsule({
    sessionId: 'sess-1',
    turnId: 'turn-1',
    events: [{ category: 'search', status: 'done' }],
  });
  const b = evidenceBuilder.buildEvidenceCapsule({
    sessionId: 'sess-1',
    turnId: 'turn-1',
    events: [{ category: 'search', status: 'done' }],
  });

  assert.equal(a.evidenceHash, b.evidenceHash);
});

// ---------------------------------------------------------------------------
// 3. Python prompt adapter (requires Hermes 0.19.0 installed)
// ---------------------------------------------------------------------------
console.log('\n--- learning_prompt_adapter.py ---');

const ADAPTER_SCRIPT = path.join(__dirname, 'hermes-capabilities', 'learning_prompt_adapter.py');

let pythonExe;
try {
  pythonExe = resolveHermesPython();
} catch (err) {
  console.log('  SKIP: Hermes Python not found — skipping adapter tests');
  pythonExe = null;
}

if (pythonExe) {
  test('adapter: explicit prompt from build_learn_prompt', () => {
    const result = spawnSync(pythonExe, [ADAPTER_SCRIPT], {
      input: JSON.stringify({ mode: 'explicit', request: 'Test learn request' }),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    });

    assert.equal(result.status, 0, `exit code ${result.status}: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(parsed.success, `adapter failed: ${parsed.error}`);
    assert.equal(parsed.mode, 'explicit');
    assert.ok(parsed.prompt && parsed.prompt.length > 0);
    assert.ok(parsed.prompt.includes('/learn'));
    assert.ok(parsed.prompt.includes('Test learn request'));
    assert.equal(parsed.hermesVersion, '0.19.0');
    assert.ok(typeof parsed.promptHash === 'string');
    assert.ok(parsed.promptHash.startsWith('sha256:'));
  });

  test('adapter: implicit prompt from _SKILL_REVIEW_PROMPT', () => {
    const result = spawnSync(pythonExe, [ADAPTER_SCRIPT], {
      input: JSON.stringify({ mode: 'implicit', request: '' }),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    });

    assert.equal(result.status, 0, `exit code ${result.status}: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(parsed.success, `adapter failed: ${parsed.error}`);
    assert.equal(parsed.mode, 'implicit');
    assert.ok(parsed.prompt && parsed.prompt.length > 0);
    assert.ok(parsed.prompt.includes('Review the conversation above'));
    assert.ok(parsed.prompt.includes('SKILL.md'));
    assert.equal(parsed.hermesVersion, '0.19.0');
    assert.ok(typeof parsed.promptHash === 'string');
    assert.ok(parsed.promptHash.startsWith('sha256:'));
  });

  test('adapter: explicit and implicit produce different prompt hashes', () => {
    const explicitResult = spawnSync(pythonExe, [ADAPTER_SCRIPT], {
      input: JSON.stringify({ mode: 'explicit', request: 'test' }),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    });

    const implicitResult = spawnSync(pythonExe, [ADAPTER_SCRIPT], {
      input: JSON.stringify({ mode: 'implicit', request: '' }),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    });

    const explicitHash = JSON.parse(explicitResult.stdout.trim()).promptHash;
    const implicitHash = JSON.parse(implicitResult.stdout.trim()).promptHash;
    assert.notEqual(explicitHash, implicitHash);
  });

  test('adapter: stable hash for implicit prompt', () => {
    const a = spawnSync(pythonExe, [ADAPTER_SCRIPT], {
      input: JSON.stringify({ mode: 'implicit', request: '' }),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    });

    const b = spawnSync(pythonExe, [ADAPTER_SCRIPT], {
      input: JSON.stringify({ mode: 'implicit', request: '' }),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    });

    const hashA = JSON.parse(a.stdout.trim()).promptHash;
    const hashB = JSON.parse(b.stdout.trim()).promptHash;
    assert.equal(hashA, hashB);
  });

  test('adapter: stable hash for explicit prompt with same request', () => {
    const a = spawnSync(pythonExe, [ADAPTER_SCRIPT], {
      input: JSON.stringify({ mode: 'explicit', request: 'test request' }),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    });

    const b = spawnSync(pythonExe, [ADAPTER_SCRIPT], {
      input: JSON.stringify({ mode: 'explicit', request: 'test request' }),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    });

    const hashA = JSON.parse(a.stdout.trim()).promptHash;
    const hashB = JSON.parse(b.stdout.trim()).promptHash;
    assert.equal(hashA, hashB);
  });

  test('adapter: rejects unknown mode', () => {
    const result = spawnSync(pythonExe, [ADAPTER_SCRIPT], {
      input: JSON.stringify({ mode: 'invalid' }),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    });

    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(!parsed.success);
  });
}

// ---------------------------------------------------------------------------
// 4. orchestrator.js (pure functions only, no live runner)
// ---------------------------------------------------------------------------
console.log('\n--- orchestrator.js ---');

const orchestrator = require('./learning-loop/orchestrator');

test('orchestrator: buildLearningPrompt includes adapter', () => {
  const prompt = orchestrator.buildLearningPrompt({
    officialPrompt: 'OFFICIAL PROMPT',
    capsule: { schemaVersion: 1, source: { sessionId: 's1', turnId: 't1' } },
  });

  assert.ok(prompt.includes('OFFICIAL PROMPT'));
  assert.ok(prompt.includes('EVIDENCE CAPSULE'));
  assert.ok(prompt.includes('TRYLO LEARNING ADAPTER'));
  assert.ok(prompt.includes('skill_propose'));
});

test('orchestrator: getActiveRunStatus returns null initially', () => {
  orchestrator.resetState();
  const status = orchestrator.getActiveRunStatus();
  assert.equal(status, null);
});

test('orchestrator: resetState clears state', () => {
  orchestrator.resetState();
  const status = orchestrator.getActiveRunStatus();
  assert.equal(status, null);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
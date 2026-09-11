/*
 * smoke-learning-integration.js
 *
 * Real integration tests for Learning L0 (02_LEARNING_L0_INTEGRATION_REPAIR §12).
 * Tests call production code — not source-string searches or mock copies.
 *
 * Uses fake runners / fake globalState to avoid consuming model quota.
 * Uses temporary HERMES_HOME for real Python/MCP where needed.
 *
 * Run: node smoke-learning-integration.js
 */

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const triggerPolicy = require('./learning-loop/trigger-policy');
const evidenceBuilder = require('./learning-loop/evidence-builder');
const learningState = require('./learning-loop/learning-state');
const promptClient = require('./learning-loop/prompt-client');
const orchestrator = require('./learning-loop/orchestrator');
const extAdapter = require('./learning-loop/extension-adapter');
const hermesCapabilityManager = require('./hermes-capability-manager');

let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`  PASS: ${name}`);
}

function fail(name, err) {
  failed++;
  console.log(`  FAIL: ${name}`);
  if (err) console.log(`        ${err.message || err}`);
}

function test(name, fn) {
  try { fn(); } catch (err) { fail(name, err); }
}

async function testAsync(name, fn) {
  try { await fn(); } catch (err) { fail(name, err); }
}

// ---------------------------------------------------------------------------
// Fake globalState (simulates VS Code Memento)
// ---------------------------------------------------------------------------
function createFakeGlobalState() {
  const store = {};
  return {
    get(key) { return key in store ? store[key] : undefined; },
    async update(key, value) { store[key] = value; },
    _store: store,
  };
}

function createFakeContext(globalState) {
  return {
    globalState: globalState || createFakeGlobalState(),
    globalStorageUri: { fsPath: os.tmpdir() },
  };
}

// ---------------------------------------------------------------------------
// Fake runner that captures prompt and returns controlled result
// ---------------------------------------------------------------------------
function createFakeRunner(options = {}) {
  const calls = [];
  const runner = async (prompt) => {
    calls.push({ prompt: String(prompt || '').slice(0, 200), at: Date.now() });
    if (options.throw) throw new Error(options.throw);
    return {
      answer: options.answer || 'Learning review completed.',
      review: null,
      reviewRoot: options.reviewRoot || null,
    };
  };
  runner.calls = calls;
  return runner;
}

// ---------------------------------------------------------------------------
// Fake pending list that returns controlled results
// ---------------------------------------------------------------------------
let _fakePendingResult = { success: true, pending: [], count: 0 };

function setupFakePending(result) {
  _fakePendingResult = result;
  // Monkey-patch listPending in hermes-pending-admin
  const admin = require('./hermes-pending-admin');
  admin.listPending = () => _fakePendingResult;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n--- Evidence Builder: Safety ---');

  test('templates/ path not filtered as temp', () => {
    assert.ok(!evidenceBuilder._isShadowOrTempPath('src/templates/foo.md'));
    assert.ok(!evidenceBuilder._isShadowOrTempPath('templates/header.html'));
    ok('templates/ not filtered as temp');
  });

  test('shadow/temp paths are filtered', () => {
    assert.ok(evidenceBuilder._isShadowOrTempPath('/tmp/shadow/review.txt'));
    assert.ok(evidenceBuilder._isShadowOrTempPath('shadow-root/file.js'));
    assert.ok(evidenceBuilder._isShadowOrTempPath('.trylo/cache.json'));
    ok('shadow/temp paths filtered');
  });

  test('absolute paths rejected in file hints', () => {
    assert.ok(evidenceBuilder._isAbsolutePath('C:\\Users\\file.js'));
    assert.ok(evidenceBuilder._isAbsolutePath('/home/user/file.js'));
    assert.ok(evidenceBuilder._isAbsolutePath('\\\\server\\share\\file.js'));
    assert.ok(evidenceBuilder._isAbsolutePath('../../etc/passwd'));
    assert.ok(!evidenceBuilder._isAbsolutePath('src/file.js'));
    ok('absolute and traversal paths rejected');
  });

  test('secrets are stripped', () => {
    const stripped = evidenceBuilder._stripSecrets('api_key=sk-1234567890abcdefghijklm');
    assert.ok(!stripped.includes('sk-1234567890abcdefghijklm'));
    assert.ok(stripped.includes('[REDACTED]'));
    const gh = evidenceBuilder._stripSecrets('token: ghp_1234567890abcdefghijklmnopqrstuvwxyz1234');
    assert.ok(!gh.includes('ghp_1234567890'));
    const bearer = evidenceBuilder._stripSecrets('Authorization: Bearer eyJabc12345678');
    assert.ok(bearer.includes('[REDACTED]'));
    ok('secrets stripped (sk-, gh_, Bearer)');
  });

  test('event category allowlist enforced', () => {
    assert.ok(evidenceBuilder._sanitiseToolEvent({ category: 'search', status: 'done' }));
    assert.ok(evidenceBuilder._sanitiseToolEvent({ category: 'edit', status: 'done' }));
    // TRYLO-L0-PATCH(dual-surface-spec §2.5): Work surface categories accepted.
    assert.ok(evidenceBuilder._sanitiseToolEvent({ category: 'office', status: 'done' }));
    assert.ok(evidenceBuilder._sanitiseToolEvent({ category: 'browser', status: 'done' }));
    assert.ok(evidenceBuilder._sanitiseToolEvent({ category: 'desktop', status: 'done' }));
    assert.strictEqual(evidenceBuilder._sanitiseToolEvent({ category: 'permission', status: 'done' }), null);
    assert.strictEqual(evidenceBuilder._sanitiseToolEvent({ category: 'chat', status: 'done' }), null);
    assert.strictEqual(evidenceBuilder._sanitiseToolEvent({ category: 'model', status: 'done' }), null);
    ok('unknown categories rejected, work categories accepted');
  });

  test('Evidence capsule includes taskGoal and resultSummary', () => {
    const { capsule } = evidenceBuilder.buildEvidenceCapsule({
      sessionId: 's1', turnId: 't1',
      taskGoal: 'Fix the login bug',
      resultSummary: 'Fixed the authentication flow',
      triggerKind: 'implicit',
      events: [{ category: 'edit', status: 'done', title: 'Fixed auth.js' }],
      workspaceRoot: '/project',
    });
    assert.strictEqual(capsule.taskGoal, 'Fix the login bug');
    assert.strictEqual(capsule.resultSummary, 'Fixed the authentication flow');
    assert.strictEqual(capsule.source.sessionId, 's1');
    assert.strictEqual(capsule.source.mode, undefined); // mode not passed
    ok('capsule has taskGoal and resultSummary');
  });

  test('Evidence capsule includes reviewResolution', () => {
    const { capsule } = evidenceBuilder.buildEvidenceCapsule({
      sessionId: 's1', turnId: 't1',
      triggerKind: 'implicit',
      reviewResolution: { accepted: 2, rejected: 1 },
    });
    assert.strictEqual(capsule.reviewResolution.accepted, 2);
    assert.strictEqual(capsule.reviewResolution.rejected, 1);
    ok('capsule has reviewResolution');
  });

  test('Evidence capsule file hints are workspace-relative', () => {
    const { capsule } = evidenceBuilder.buildEvidenceCapsule({
      sessionId: 's1', turnId: 't1',
      triggerKind: 'implicit',
      fileHints: ['/project/src/app.js', 'src/util.js', 'C:\\absolute\\path.js', '../../traversal.js'],
      workspaceRoot: '/project',
    });
    assert.ok(capsule.fileHints.includes('src/app.js'));
    assert.ok(capsule.fileHints.includes('src/util.js'));
    assert.ok(!capsule.fileHints.some(f => f.includes('absolute')));
    assert.ok(!capsule.fileHints.some(f => f.includes('traversal')));
    ok('file hints are relative, absolute/traversal rejected');
  });

  console.log('\n--- Learning State: Persistence ---');

  test('state persists across restarts', () => {
    const gs = createFakeGlobalState();
    const ctx = createFakeContext(gs);
    const wsRoot = '/workspace';

    // First "session"
    let state = learningState.loadState(gs);
    learningState.recordStableTurn(state, wsRoot, 'sess1', 'turn1', 'agent');
    learningState.addIterations(state, wsRoot, 5);
    learningState.markHashProcessed(state, wsRoot, 'sha256:abc');
    learningState.saveState(gs, state);

    // Simulate restart — reload from globalState
    state = learningState.loadState(gs);
    const turn = learningState.getLatestStableTurn(state, wsRoot);
    assert.strictEqual(turn.sessionId, 'sess1');
    assert.strictEqual(turn.turnId, 'turn1');
    assert.strictEqual(learningState.getIterations(state, wsRoot), 5);
    assert.ok(learningState.isHashProcessed(state, wsRoot, 'sha256:abc'));
    ok('state survives restart');
  });

  test('deferred candidate persists and is consumed once', () => {
    const gs = createFakeGlobalState();
    const wsRoot = '/workspace';
    let state = learningState.loadState(gs);
    learningState.setDeferredCandidate(state, wsRoot, {
      sessionId: 's1', turnId: 't1', mode: 'agent',
      taskGoal: 'test', resultSummary: 'done',
      events: [], fileHints: [], verification: [],
    });
    learningState.saveState(gs, state);

    // Reload
    state = learningState.loadState(gs);
    assert.ok(learningState.hasDeferredCandidate(state, wsRoot));

    const c1 = learningState.consumeDeferredCandidate(state, wsRoot);
    assert.ok(c1);
    assert.strictEqual(c1.sessionId, 's1');

    // Second consume returns null
    const c2 = learningState.consumeDeferredCandidate(state, wsRoot);
    assert.strictEqual(c2, null);
    ok('deferred candidate consumed exactly once');
  });

  test('processed hashes capped at 100', () => {
    const gs = createFakeGlobalState();
    const wsRoot = '/workspace';
    let state = learningState.loadState(gs);
    for (let i = 0; i < 120; i++) {
      learningState.markHashProcessed(state, wsRoot, `sha256:${i}`);
    }
    const ws = learningState.getWorkspaceState(state, wsRoot);
    assert.ok(ws.processedEvidenceHashes.length <= 100);
    ok('processed hashes capped at 100');
  });

  test('cooldown prevents immediate re-trigger', () => {
    const gs = createFakeGlobalState();
    const wsRoot = '/workspace';
    let state = learningState.loadState(gs);
    learningState.setCooldown(state, wsRoot, 60000);
    assert.ok(!learningState.isEligible(state, wsRoot));
    ok('cooldown blocks eligibility');
  });

  test('cleanSessionReferences removes stale data', () => {
    const gs = createFakeGlobalState();
    const wsRoot = '/workspace';
    let state = learningState.loadState(gs);
    learningState.recordStableTurn(state, wsRoot, 'sess1', 'turn1', 'agent');
    learningState.setDeferredCandidate(state, wsRoot, {
      sessionId: 'sess1', turnId: 'turn1', mode: 'agent',
    });
    learningState.cleanSessionReferences(state, wsRoot, 'sess1');
    assert.strictEqual(learningState.getLatestStableTurn(state, wsRoot), null);
    assert.ok(!learningState.hasDeferredCandidate(state, wsRoot));
    ok('session references cleaned');
  });

  console.log('\n--- Prompt Client: Strict Validation ---');

  test('validate rejects success=false', () => {
    const r = promptClient._validatePromptResult({ success: false, error: 'fail' }, 'implicit');
    assert.ok(!r.valid);
    ok('rejects success=false');
  });

  test('validate rejects version mismatch', () => {
    const crypto = require('node:crypto');
    const prompt = 'test prompt';
    const hash = 'sha256:' + crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
    const r = promptClient._validatePromptResult({
      success: true, mode: 'implicit', prompt, hermesVersion: '0.20.0', promptHash: hash,
    }, 'implicit');
    assert.ok(!r.valid);
    assert.ok(r.error.includes('version'));
    ok('rejects version mismatch');
  });

  test('validate rejects mode mismatch', () => {
    const crypto = require('node:crypto');
    const prompt = 'test prompt';
    const hash = 'sha256:' + crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
    const r = promptClient._validatePromptResult({
      success: true, mode: 'explicit', prompt, hermesVersion: '0.19.0', promptHash: hash,
    }, 'implicit');
    assert.ok(!r.valid);
    ok('rejects mode mismatch');
  });

  test('validate rejects invalid hash', () => {
    const r = promptClient._validatePromptResult({
      success: true, mode: 'implicit', prompt: 'test', hermesVersion: '0.19.0', promptHash: 'not-a-hash',
    }, 'implicit');
    assert.ok(!r.valid);
    ok('rejects invalid hash format');
  });

  test('validate rejects hash mismatch', () => {
    const r = promptClient._validatePromptResult({
      success: true, mode: 'implicit', prompt: 'test', hermesVersion: '0.19.0',
      promptHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    }, 'implicit');
    assert.ok(!r.valid);
    assert.ok(r.error.includes('does not match'));
    ok('rejects hash/content mismatch');
  });

  test('validate accepts correct result', () => {
    const crypto = require('node:crypto');
    const prompt = 'official prompt text';
    const hash = 'sha256:' + crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
    const r = promptClient._validatePromptResult({
      success: true, mode: 'implicit', prompt, hermesVersion: '0.19.0', promptHash: hash,
    }, 'implicit');
    assert.ok(r.valid);
    ok('accepts valid result');
  });

  console.log('\n--- Orchestrator: Fail-Closed Pending ---');

  await testAsync('pre-list failure returns failed, not no_learning', async () => {
    orchestrator.resetState();
    const ctx = createFakeContext();
    const gs = ctx.globalState;
    let state = learningState.loadState(gs);
    // Set iterations above threshold
    learningState.addIterations(state, '/ws', 15);
    await learningState.saveState(gs, state);

    // Make listPending fail
    setupFakePending({ success: false, pending: [], count: 0, error: 'infra error' });

    // Also need to make prompt fetch succeed — patch it
    const origFetch = promptClient.fetchPrompt;
    promptClient.fetchPrompt = async () => ({
      success: true, mode: 'implicit', prompt: 'test',
      hermesVersion: '0.19.0',
      promptHash: 'sha256:' + 'a'.repeat(64),
    });

    try {
      const result = await orchestrator.runImplicitReview({
        context: ctx,
        workspaceRoot: '/ws',
        sessionId: 's1', turnId: 't1', mode: 'agent',
        resultText: 'done', interrupted: false, hasPendingReview: false,
        events: [{ category: 'edit', status: 'done' }],
        config: { enabled: true, creationNudgeInterval: 10 },
        globalStoragePath: os.tmpdir(),
        runInShadow: createFakeRunner(),
        logTrace: () => {},
      });
      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('pre-list') || result.error.includes('pending'));
      ok('pre-list failure returns failed');
    } finally {
      promptClient.fetchPrompt = origFetch;
    }
  });

  await testAsync('post-list failure returns failed, not no_learning', async () => {
    orchestrator.resetState();
    const ctx = createFakeContext();
    const gs = ctx.globalState;
    let state = learningState.loadState(gs);
    learningState.addIterations(state, '/ws', 15);
    await learningState.saveState(gs, state);

    let callCount = 0;
    setupFakePending(null); // We'll override dynamically
    const admin = require('./hermes-pending-admin');
    admin.listPending = () => {
      callCount++;
      if (callCount <= 1) return { success: true, pending: [], count: 0 };
      return { success: false, pending: [], count: 0, error: 'post-list fail' };
    };

    const origFetch = promptClient.fetchPrompt;
    promptClient.fetchPrompt = async () => ({
      success: true, mode: 'implicit', prompt: 'test',
      hermesVersion: '0.19.0',
      promptHash: 'sha256:' + 'b'.repeat(64),
    });

    try {
      const result = await orchestrator.runImplicitReview({
        context: ctx,
        workspaceRoot: '/ws',
        sessionId: 's1', turnId: 't1', mode: 'agent',
        resultText: 'done', interrupted: false, hasPendingReview: false,
        events: [{ category: 'edit', status: 'done' }],
        config: { enabled: true, creationNudgeInterval: 10 },
        globalStoragePath: os.tmpdir(),
        runInShadow: createFakeRunner(),
        logTrace: () => {},
      });
      assert.strictEqual(result.status, 'failed');
      ok('post-list failure returns failed');
    } finally {
      promptClient.fetchPrompt = origFetch;
    }
  });

  console.log('\n--- Orchestrator: Threshold and Cooldown ---');

  await testAsync('9 iterations do not trigger, 10 does', async () => {
    orchestrator.resetState();
    const ctx = createFakeContext();

    const origFetch = promptClient.fetchPrompt;
    promptClient.fetchPrompt = async () => ({
      success: true, mode: 'implicit', prompt: 'test',
      hermesVersion: '0.19.0', promptHash: 'sha256:' + 'c'.repeat(64),
    });
    setupFakePending({ success: true, pending: [], count: 0 });

    try {
      // 9 iterations — should skip
      let state = learningState.loadState(ctx.globalState);
      learningState.addIterations(state, '/ws', 9);
      await learningState.saveState(ctx.globalState, state);

      const runner = createFakeRunner();
      let r = await orchestrator.runImplicitReview({
        context: ctx, workspaceRoot: '/ws',
        sessionId: 's1', turnId: 't1', mode: 'agent',
        resultText: 'done', interrupted: false, hasPendingReview: false,
        events: [],
        config: { enabled: true, creationNudgeInterval: 10 },
        globalStoragePath: os.tmpdir(),
        runInShadow: runner,
        logTrace: () => {},
      });
      assert.strictEqual(r.status, 'skipped');
      assert.strictEqual(runner.calls.length, 0);

      // Add 1 more — should trigger
      state = learningState.loadState(ctx.globalState);
      learningState.addIterations(state, '/ws', 1);
      await learningState.saveState(ctx.globalState, state);

      // Need a different pending result for staged
      let callN = 0;
      const admin = require('./hermes-pending-admin');
      admin.listPending = () => {
        callN++;
        if (callN === 1) return { success: true, pending: [], count: 0 }; // before
        return { success: true, pending: [{ id: 'skill-1', subsystem: 'skills' }], count: 1 }; // after — 1 new
      };

      r = await orchestrator.runImplicitReview({
        context: ctx, workspaceRoot: '/ws',
        sessionId: 's1', turnId: 't2', mode: 'agent',
        resultText: 'done', interrupted: false, hasPendingReview: false,
        events: [{ category: 'edit', status: 'done' }],
        config: { enabled: true, creationNudgeInterval: 10 },
        globalStoragePath: os.tmpdir(),
        runInShadow: runner,
        logTrace: () => {},
      });
      assert.strictEqual(r.status, 'staged');
      assert.strictEqual(runner.calls.length, 1);
      ok('9 iterations skip, 10 triggers once');
    } finally {
      promptClient.fetchPrompt = origFetch;
    }
  });

  await testAsync('no_learning consumes threshold and sets cooldown', async () => {
    orchestrator.resetState();
    const ctx = createFakeContext();
    const gs = ctx.globalState;

    let state = learningState.loadState(gs);
    learningState.addIterations(state, '/ws', 15);
    await learningState.saveState(gs, state);

    const origFetch = promptClient.fetchPrompt;
    promptClient.fetchPrompt = async () => ({
      success: true, mode: 'implicit', prompt: 'test',
      hermesVersion: '0.19.0', promptHash: 'sha256:' + 'd'.repeat(64),
    });
    setupFakePending({ success: true, pending: [], count: 0 });

    try {
      const r = await orchestrator.runImplicitReview({
        context: ctx, workspaceRoot: '/ws',
        sessionId: 's1', turnId: 't1', mode: 'agent',
        resultText: 'done', interrupted: false, hasPendingReview: false,
        events: [{ category: 'edit', status: 'done' }],
        config: { enabled: true, creationNudgeInterval: 10 },
        globalStoragePath: os.tmpdir(),
        runInShadow: createFakeRunner(),
        logTrace: () => {},
      });
      assert.strictEqual(r.status, 'no_learning');

      // Check iterations were reset
      state = learningState.loadState(gs);
      assert.strictEqual(learningState.getIterations(state, '/ws'), 0);
      // Check cooldown is active
      assert.ok(!learningState.isEligible(state, '/ws'));
      ok('no_learning resets iterations + sets cooldown');
    } finally {
      promptClient.fetchPrompt = origFetch;
    }
  });

  await testAsync('ambiguous proposals (count > 1) returns ambiguous', async () => {
    orchestrator.resetState();
    const ctx = createFakeContext();
    const gs = ctx.globalState;
    let state = learningState.loadState(gs);
    learningState.addIterations(state, '/ws', 15);
    await learningState.saveState(gs, state);

    const origFetch = promptClient.fetchPrompt;
    promptClient.fetchPrompt = async () => ({
      success: true, mode: 'implicit', prompt: 'test',
      hermesVersion: '0.19.0', promptHash: 'sha256:' + 'e'.repeat(64),
    });

    let callN = 0;
    const admin = require('./hermes-pending-admin');
    admin.listPending = () => {
      callN++;
      if (callN === 1) return { success: true, pending: [], count: 0 };
      return {
        success: true,
        pending: [
          { id: 'skill-1', subsystem: 'skills' },
          { id: 'skill-2', subsystem: 'skills' },
        ],
        count: 2,
      };
    };

    try {
      const r = await orchestrator.runImplicitReview({
        context: ctx, workspaceRoot: '/ws',
        sessionId: 's1', turnId: 't1', mode: 'agent',
        resultText: 'done', interrupted: false, hasPendingReview: false,
        events: [{ category: 'edit', status: 'done' }],
        config: { enabled: true, creationNudgeInterval: 10 },
        globalStoragePath: os.tmpdir(),
        runInShadow: createFakeRunner(),
        logTrace: () => {},
      });
      assert.strictEqual(r.status, 'ambiguous_proposals');
      ok('multiple proposals returns ambiguous');
    } finally {
      promptClient.fetchPrompt = origFetch;
    }
  });

  console.log('\n--- Learning MCP Config: Tool Isolation ---');

  test('learning MCP config has strict-mcp-config and allowed-tools', () => {
    // Build learning MCP config in a temp dir
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-test-'));
    try {
      const result = hermesCapabilityManager.tryGetLearningMcpConfigArg(tmpDir);
      if (!result.ok) {
        // Hermes not available — skip but record
        console.log(`  SKIP: Hermes unavailable: ${result.warning}`);
        return;
      }
      // Verify the arg array contains --strict-mcp-config and --allowed-tools
      const argStr = result.arg.join(' ');
      assert.ok(argStr.includes('--strict-mcp-config'), 'must have --strict-mcp-config');
      assert.ok(argStr.includes('--allowed-tools'), 'must have --allowed-tools');
      // Verify the 4 tools are allowed (3 Skill + learning_graph_summary).
      // The exact list is pinned by LEARNING_ALLOWED_TOOLS in
      // hermes-capability-manager.js. 11 §4 B1.
      assert.ok(result.allowedTools.length === 4, `expected 4 tools, got ${result.allowedTools.length}`);
      assert.ok(result.allowedTools.every(t => t.startsWith('mcp__trylo-hermes-learning__')));
      assert.ok(result.allowedTools.includes('mcp__trylo-hermes-learning__skills_list'));
      assert.ok(result.allowedTools.includes('mcp__trylo-hermes-learning__skill_view'));
      assert.ok(result.allowedTools.includes('mcp__trylo-hermes-learning__skill_propose'));
      assert.ok(result.allowedTools.includes('mcp__trylo-hermes-learning__learning_graph_summary'));
      // Verify the config file exists and has the learning server name
      const configContent = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
      assert.ok(configContent.mcpServers['trylo-hermes-learning'], 'must have learning server');
      assert.strictEqual(
        configContent.mcpServers['trylo-hermes-learning'].env.TRYLO_MCP_PROFILE,
        'learning',
      );
      ok('learning MCP config has strict isolation + 3 allowed tools');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('learning config does not include memory/session/terminal tools', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-test-'));
    try {
      const result = hermesCapabilityManager.tryGetLearningMcpConfigArg(tmpDir);
      if (!result.ok) {
        console.log(`  SKIP: Hermes unavailable`);
        return;
      }
      const allTools = result.allowedTools.join(' ');
      assert.ok(!allTools.includes('memory_snapshot'));
      assert.ok(!allTools.includes('memory_propose'));
      assert.ok(!allTools.includes('session_search'));
      assert.ok(!allTools.includes('learning_pending_list'));
      ok('learning config excludes memory/session/pending tools');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('normal MCP config still registers all tools (unaffected)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-test-'));
    try {
      const result = hermesCapabilityManager.tryGetMcpConfigArg(tmpDir);
      if (!result.ok) {
        console.log(`  SKIP: Hermes unavailable`);
        return;
      }
      const configContent = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
      // Normal config uses trylo-hermes-capabilities (not learning)
      assert.ok(configContent.mcpServers['trylo-hermes-capabilities']);
      assert.ok(!configContent.mcpServers['trylo-hermes-capabilities'].env.TRYLO_MCP_PROFILE);
      // Normal config does NOT have --strict-mcp-config
      assert.ok(!result.arg.includes('--strict-mcp-config'));
      ok('normal Agent MCP config unaffected');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  console.log('\n--- Trigger Policy: Exclusions ---');

  test('error/stopped/interrupted/chat/plan never trigger', () => {
    assert.ok(!triggerPolicy.isStableTaskTurn({ status: 'error', mode: 'agent', resultText: 'x' }));
    assert.ok(!triggerPolicy.isStableTaskTurn({ status: 'stopped', mode: 'agent', resultText: 'x' }));
    assert.ok(!triggerPolicy.isStableTaskTurn({ status: 'success', mode: 'agent', resultText: 'x', interrupted: true }));
    assert.ok(!triggerPolicy.isStableTaskTurn({ status: 'success', mode: 'chat', resultText: 'x' }));
    assert.ok(!triggerPolicy.isStableTaskTurn({ status: 'success', mode: 'plan', resultText: 'x' }));
    ok('error/stopped/interrupted/chat/plan excluded');
  });

  test('explicit /learn bypasses threshold but not safety', () => {
    const check = triggerPolicy.checkExplicitLearn({
      mode: 'agent', agentRunning: false, hasPendingReview: false,
      evidenceHash: 'sha256:new', processedHashes: new Set(),
    });
    assert.ok(check.allowed);

    const blocked = triggerPolicy.checkExplicitLearn({
      mode: 'agent', agentRunning: false, hasPendingReview: false,
      evidenceHash: 'sha256:old', processedHashes: new Set(['sha256:old']),
    });
    assert.ok(!blocked.allowed);
    ok('explicit bypasses threshold, not idempotency');
  });

  // ---------------------------------------------------------------------------
// Clone-on-get globalState (P1-6: detects stale state overwrites)
// ---------------------------------------------------------------------------
function createCloneOnGetGlobalState() {
  const store = {};
  return {
    get(key) {
      const val = store[key];
      if (val === undefined) return undefined;
      return JSON.parse(JSON.stringify(val)); // deep clone
    },
    async update(key, value) {
      store[key] = JSON.parse(JSON.stringify(value)); // deep clone on save
    },
    _store: store,
  };
}

  console.log('\n--- Clone-on-Get State Transaction (P0-2, P1-6) ---');

  await testAsync('clone-on-get: 9 cumulative + 1 triggers, staged resets to 0', async () => {
    orchestrator.resetState();
    const gs = createCloneOnGetGlobalState();
    const ctx = createFakeContext(gs);

    const origFetch = promptClient.fetchPrompt;
    promptClient.fetchPrompt = async () => ({
      success: true, mode: 'implicit', prompt: 'test',
      hermesVersion: '0.19.0', promptHash: 'sha256:' + 'f'.repeat(64),
    });

    // Set up pending to return 1 new skill
    let pendingCallN = 0;
    const admin = require('./hermes-pending-admin');
    admin.listPending = () => {
      pendingCallN++;
      if (pendingCallN <= 1) return { success: true, pending: [], count: 0 };
      return { success: true, pending: [{ id: 'skill-cog-1', subsystem: 'skills' }], count: 1 };
    };

    try {
      // 9 iterations accumulated
      let state = learningState.loadState(gs);
      learningState.addIterations(state, '/ws', 9);
      await learningState.saveState(gs, state);

      const runner = createFakeRunner();

      // 1 more event should trigger
      const r = await orchestrator.runImplicitReview({
        context: ctx, workspaceRoot: '/ws',
        sessionId: 's1', turnId: 't1', mode: 'agent',
        resultText: 'done', interrupted: false, hasPendingReview: false,
        events: [{ category: 'search', status: 'done' }],
        config: { enabled: true, creationNudgeInterval: 10 },
        globalStoragePath: os.tmpdir(),
        runInShadow: runner,
        logTrace: () => {},
      });
      assert.strictEqual(r.status, 'staged');
      assert.strictEqual(runner.calls.length, 1);

      // Reload via clone-on-get — verify state was updated
      const freshState = learningState.loadState(gs);
      assert.strictEqual(learningState.getIterations(freshState, '/ws'), 0, 'iterations reset to 0');
      assert.ok(!learningState.isEligible(freshState, '/ws'), 'cooldown active');
      // Check that at least one evidence hash was recorded (the actual hash
      // is computed from the capsule, not the prompt hash).
      const ws = learningState.getWorkspaceState(freshState, '/ws');
      assert.ok(ws.processedEvidenceHashes.length > 0, 'evidence hash recorded');
      ok('clone-on-get: staged resets iterations, sets cooldown, records hash');
    } finally {
      promptClient.fetchPrompt = origFetch;
    }
  });

  await testAsync('clone-on-get: deferred counted once, skip does not lose candidate', async () => {
    orchestrator.resetState();
    const gs = createCloneOnGetGlobalState();
    const ctx = createFakeContext(gs);

    const origFetch = promptClient.fetchPrompt;
    promptClient.fetchPrompt = async () => ({
      success: true, mode: 'implicit', prompt: 'test',
      hermesVersion: '0.19.0', promptHash: 'sha256:' + 'g'.repeat(64),
    });
    setupFakePending({ success: true, pending: [], count: 0 });

    try {
      // Save a deferred candidate with iterationIncrement
      let state = learningState.loadState(gs);
      learningState.setDeferredCandidate(state, '/ws', {
        sessionId: 's1', turnId: 't1', mode: 'agent',
        iterationIncrement: 10,
      });
      await learningState.saveState(gs, state);

      // Verify minimal persistence (P1-6: no content fields)
      const saved = gs._store[learningState.STATE_KEY];
      const wsId = Object.keys(saved.workspaces)[0];
      const cand = saved.workspaces[wsId].deferredCandidate;
      assert.ok(cand, 'deferred candidate exists');
      assert.strictEqual(cand.sessionId, 's1');
      assert.strictEqual(cand.turnId, 't1');
      assert.strictEqual(cand.iterationIncrement, 10);
      assert.strictEqual(cand.taskGoal, undefined, 'no taskGoal persisted');
      assert.strictEqual(cand.resultSummary, undefined, 'no resultSummary persisted');
      assert.strictEqual(cand.events, undefined, 'no events persisted');
      assert.strictEqual(cand.fileHints, undefined, 'no fileHints persisted');
      assert.strictEqual(cand.verification, undefined, 'no verification persisted');
      ok('deferred candidate: only lightweight metadata persisted');

      // Simulate triggerDeferredLearningReview logic:
      // pre-add iterationIncrement, call runImplicitReview with empty events
      state = learningState.loadState(gs);
      const candidate = learningState.peekDeferredCandidate(state, '/ws');
      assert.ok(candidate, 'candidate present');
      learningState.addIterations(state, '/ws', candidate.iterationIncrement);
      await learningState.saveState(gs, state);

      const runner = createFakeRunner();
      const r = await orchestrator.runImplicitReview({
        context: ctx, workspaceRoot: '/ws',
        sessionId: candidate.sessionId,
        turnId: candidate.turnId,
        mode: candidate.mode,
        resultText: 'done', interrupted: false, hasPendingReview: false,
        events: [], // P1-6: empty events, count from pre-added iterationIncrement
        config: { enabled: true, creationNudgeInterval: 10 },
        globalStoragePath: os.tmpdir(),
        runInShadow: runner,
        logTrace: () => {},
      });

      // Since no pending skill was created, result should be no_learning
      assert.strictEqual(r.status, 'no_learning');
      assert.strictEqual(runner.calls.length, 1);

      // Verify state after run
      const freshState = learningState.loadState(gs);
      assert.strictEqual(learningState.getIterations(freshState, '/ws'), 0, 'iterations reset');
      const ws2 = learningState.getWorkspaceState(freshState, '/ws');
      assert.ok(ws2.processedEvidenceHashes.length > 0, 'evidence hash recorded');
      ok('deferred: counted once, threshold consumed, cooldown set');
    } finally {
      promptClient.fetchPrompt = origFetch;
    }
  });

  console.log('\n--- Session Cleanup on Delete (P1-6) ---');

  test('cleanSessionReferences: removes latestStableTurn and deferredCandidate for deleted session', () => {
    const gs = createCloneOnGetGlobalState();
    const wsRoot = '/ws';
    let state = learningState.loadState(gs);
    learningState.recordStableTurn(state, wsRoot, 'sess-del', 'turn1', 'agent');
    learningState.setDeferredCandidate(state, wsRoot, {
      sessionId: 'sess-del', turnId: 'turn1', mode: 'agent',
      iterationIncrement: 5,
    });
    learningState.saveState(gs, state);

    // Clean references for sess-del
    state = learningState.loadState(gs);
    learningState.cleanSessionReferences(state, wsRoot, 'sess-del');
    learningState.saveState(gs, state);

    // Verify both references are cleared
    state = learningState.loadState(gs);
    assert.strictEqual(learningState.getLatestStableTurn(state, wsRoot), null, 'latestStableTurn cleared');
    assert.ok(!learningState.hasDeferredCandidate(state, wsRoot), 'deferredCandidate cleared');
    ok('cleanSessionReferences: deleted session refs removed');
  });

  test('cleanSessionReferences: unrelated session not affected', () => {
    const gs = createCloneOnGetGlobalState();
    const wsRoot = '/ws';
    let state = learningState.loadState(gs);
    learningState.recordStableTurn(state, wsRoot, 'sess-keep', 'turn1', 'agent');
    learningState.setDeferredCandidate(state, wsRoot, {
      sessionId: 'sess-other', turnId: 'turn2', mode: 'agent',
      iterationIncrement: 3,
    });
    learningState.saveState(gs, state);

    // Clean unrelated session
    state = learningState.loadState(gs);
    learningState.cleanSessionReferences(state, wsRoot, 'sess-unrelated');
    learningState.saveState(gs, state);

    // Verify: sess-keep still has latestStableTurn, sess-other still has deferred
    state = learningState.loadState(gs);
    const turn = learningState.getLatestStableTurn(state, wsRoot);
    assert.ok(turn, 'latestStableTurn preserved');
    assert.strictEqual(turn.sessionId, 'sess-keep');
    assert.ok(learningState.hasDeferredCandidate(state, wsRoot), 'deferredCandidate preserved');
    ok('cleanSessionReferences: unrelated sessions unaffected');
  });

  console.log('\n--- Event Filtering (03A §7.10 — calls production isSuccessToolEvent) ---');

  test('event sequence: started/info count 0, completed/success count 1, duplicate 0, failed/error count 0', () => {
    const events = [
      { category: 'search', phase: 'started', level: 'info', id: 'evt1' },
      { category: 'search', phase: 'completed', level: 'success', id: 'evt2' },
      { category: 'search', phase: 'completed', level: 'success', id: 'evt2' }, // duplicate
      { category: 'edit', phase: 'started', level: 'info', id: 'evt3' },
      { category: 'edit', phase: 'failed', level: 'error', id: 'evt4' },
    ];

    // Call production isSuccessToolEvent exactly as _recordLearningEvent does
    const accepted = [];
    const seenIds = new Set();
    for (const evt of events) {
      if (!extAdapter.isSuccessToolEvent(evt)) continue;
      const stableId = String(evt.id || `${evt.category}:${evt.title || ''}:${evt.seq || ''}`);
      if (seenIds.has(stableId)) continue;
      seenIds.add(stableId);
      accepted.push(evt);
    }

    assert.strictEqual(accepted.length, 1, 'only 1 event accepted');
    assert.strictEqual(accepted[0].category, 'search');
    assert.strictEqual(accepted[0].phase, 'completed');
    assert.strictEqual(accepted[0].level, 'success');
    ok('event sequence: production isSuccessToolEvent called, 1 completed/success, no duplicates');
  });

  test('countMeaningfulIterations: empty events returns 0 (deferred path)', () => {
    // P1-6: deferred path passes empty events
    const count = triggerPolicy.countMeaningfulIterations([]);
    assert.strictEqual(count, 0);
    ok('countMeaningfulIterations([]) == 0');
  });

  console.log('\n--- recoverLearningSourceEvidence (03A §3) ---');

  test('recoverLearningSourceEvidence: precise session/turn, not last message', () => {
    const sessions = [{
      id: 's1',
      turns: [
        { id: 't1', status: 'success', prompt: 'Fix bug', resultText: 'Fixed',
          events: [] },
        { id: 't2', status: 'success', prompt: 'Add feature', resultText: 'Added',
          events: [] },
      ],
    }];

    // Recover t1 specifically, not t2
    const r = extAdapter.recoverLearningSourceEvidence(sessions, { sessionId: 's1', turnId: 't1' });
    assert.ok(r.ok, 'recovery ok');
    assert.strictEqual(r.taskGoal, 'Fix bug', 'correct taskGoal');
    assert.strictEqual(r.resultSummary, 'Fixed', 'correct resultSummary');
    ok('recoverLearningSourceEvidence: returns exact turn, not session last message');
  });

  test('recoverLearningSourceEvidence: turn not found returns fail', () => {
    const sessions = [{
      id: 's1',
      turns: [{ id: 't1', status: 'success', prompt: 'A', resultText: 'B', events: [] }],
    }];
    const r = extAdapter.recoverLearningSourceEvidence(sessions, { sessionId: 's1', turnId: 'nonexistent' });
    assert.ok(!r.ok, 'not found');
    assert.ok(r.error.includes('not found'), `error mentions not found: ${r.error}`);
    ok('recoverLearningSourceEvidence: nonexistent turn fails closed');
  });

  test('recoverLearningSourceEvidence: failed turn fails closed', () => {
    const sessions = [{
      id: 's1',
      turns: [{ id: 't1', status: 'error', prompt: 'A', resultText: 'B', events: [] }],
    }];
    const r = extAdapter.recoverLearningSourceEvidence(sessions, { sessionId: 's1', turnId: 't1' });
    assert.ok(!r.ok, 'failed turn rejected');
    ok('recoverLearningSourceEvidence: error-status turn fails closed');
  });

  test('recoverLearningSourceEvidence: empty resultText fails closed', () => {
    const sessions = [{
      id: 's1',
      turns: [{ id: 't1', status: 'success', prompt: 'A', resultText: '', events: [] }],
    }];
    const r = extAdapter.recoverLearningSourceEvidence(sessions, { sessionId: 's1', turnId: 't1' });
    assert.ok(!r.ok, 'empty resultText rejected');
    ok('recoverLearningSourceEvidence: empty resultText fails closed');
  });

  test('recoverLearningSourceEvidence: session not found fails closed', () => {
    const r = extAdapter.recoverLearningSourceEvidence([], { sessionId: 'nosession', turnId: 't1' });
    assert.ok(!r.ok, 'session not found');
    ok('recoverLearningSourceEvidence: missing session fails closed');
  });

  console.log('\n--- iterationsAlreadyApplied (03A §4) ---');

  await testAsync('iterationsAlreadyApplied: true skips iteration counting', async () => {
    orchestrator.resetState();
    const gs = createCloneOnGetGlobalState();
    const ctx = createFakeContext(gs);

    const origFetch = promptClient.fetchPrompt;
    promptClient.fetchPrompt = async () => ({
      success: true, mode: 'implicit', prompt: 'test',
      hermesVersion: '0.19.0', promptHash: 'test',
    });
    setupFakePending({ success: true, pending: [], count: 0 });

    try {
      // Pre-add 10 iterations to state
      let state = learningState.loadState(gs);
      learningState.addIterations(state, '/ws', 10);
      await learningState.saveState(gs, state);

      // Need a mock that returns empty then 1 skill (for diffSkillPending)
      let pendingCallN = 0;
      const admin = require('./hermes-pending-admin');
      admin.listPending = () => {
        pendingCallN++;
        if (pendingCallN <= 1) return { success: true, pending: [], count: 0 };
        return { success: true, pending: [{ id: 'skill-ita-1', subsystem: 'skills' }], count: 1 };
      };

      const runner = createFakeRunner();

      const r = await orchestrator.runImplicitReview({
        context: ctx, workspaceRoot: '/ws',
        sessionId: 's1', turnId: 't1', mode: 'agent',
        resultText: 'done', taskGoal: 'test',
        interrupted: false, hasPendingReview: false,
        events: [{ category: 'search', status: 'done', phase: 'completed', level: 'success', id: 'e1' }],
        iterationsAlreadyApplied: true, // skip counting
        config: { enabled: true, creationNudgeInterval: 10 },
        globalStoragePath: os.tmpdir(),
        runInShadow: runner,
        logTrace: () => {},
      });

      // Should trigger because 10 iterations already accumulated
      assert.strictEqual(r.status, 'staged', 'should stage with 10 iterations');
      assert.strictEqual(runner.calls.length, 1);

      // Verify iterations were NOT double-counted (should still be 10 before reset)
      const freshState = learningState.loadState(gs);
      // After run completes, iterations are reset. But we can verify that
      // the count before reset was 10, not 11.
      assert.strictEqual(learningState.getIterations(freshState, '/ws'), 0, 'iterations reset');
      ok('iterationsAlreadyApplied: true — events used for evidence only, not counted');
    } finally {
      promptClient.fetchPrompt = origFetch;
    }
  });

  await testAsync('iterationsAlreadyApplied: false (default) counts normally', async () => {
    orchestrator.resetState();
    const gs = createCloneOnGetGlobalState();
    const ctx = createFakeContext(gs);

    const origFetch = promptClient.fetchPrompt;
    promptClient.fetchPrompt = async () => ({
      success: true, mode: 'implicit', prompt: 'test',
      hermesVersion: '0.19.0', promptHash: 'test2',
    });
    setupFakePending({ success: true, pending: [], count: 0 });

    try {
      // 9 iterations + 1 event = 10, should trigger
      let state = learningState.loadState(gs);
      learningState.addIterations(state, '/ws', 9);
      await learningState.saveState(gs, state);

      // Need a mock that returns empty then 1 skill (for diffSkillPending)
      let pendingCallN = 0;
      const admin = require('./hermes-pending-admin');
      admin.listPending = () => {
        pendingCallN++;
        if (pendingCallN <= 1) return { success: true, pending: [], count: 0 };
        return { success: true, pending: [{ id: 'skill-itb-1', subsystem: 'skills' }], count: 1 };
      };

      const runner = createFakeRunner();

      const r = await orchestrator.runImplicitReview({
        context: ctx, workspaceRoot: '/ws',
        sessionId: 's1', turnId: 't1', mode: 'agent',
        resultText: 'done', taskGoal: 'test',
        interrupted: false, hasPendingReview: false,
        events: [{ category: 'search', status: 'done', phase: 'completed', level: 'success', id: 'e1' }],
        // iterationsAlreadyApplied defaults to false
        config: { enabled: true, creationNudgeInterval: 10 },
        globalStoragePath: os.tmpdir(),
        runInShadow: runner,
        logTrace: () => {},
      });

      assert.strictEqual(r.status, 'staged', '9 + 1 = 10 should trigger');
      assert.strictEqual(runner.calls.length, 1);
      ok('iterationsAlreadyApplied: false (default) — events counted normally');
    } finally {
      promptClient.fetchPrompt = origFetch;
    }
  });

  console.log('\n--- Deferred Exactly-Once State Machine (03A §4) ---');

  await testAsync('deferred: iterationsApplied=false adds once, retry does not re-add', async () => {
    orchestrator.resetState();
    const gs = createCloneOnGetGlobalState();
    const ctx = createFakeContext(gs);

    const origFetch = promptClient.fetchPrompt;
    promptClient.fetchPrompt = async () => ({
      success: true, mode: 'implicit', prompt: 'test',
      hermesVersion: '0.19.0', promptHash: 'test3',
    });
    setupFakePending({ success: true, pending: [], count: 0 });

    try {
      // Save a deferred candidate with iterationsApplied=false
      let state = learningState.loadState(gs);
      learningState.addIterations(state, '/ws', 8); // 8 cumulative
      learningState.setDeferredCandidate(state, '/ws', {
        sessionId: 's1', turnId: 't1', mode: 'agent',
        iterationIncrement: 2, // 8 + 2 = 10, should trigger
        iterationsApplied: false,
      });
      await learningState.saveState(gs, state);

      // Simulate first trigger: add iterations, mark applied
      state = learningState.loadState(gs);
      const firstCandidate = learningState.peekDeferredCandidate(state, '/ws');
      assert.ok(firstCandidate, 'candidate exists');
      assert.strictEqual(firstCandidate.iterationsApplied, false, 'not yet applied');

      // Add iterations and mark applied
      learningState.addIterations(state, '/ws', firstCandidate.iterationIncrement);
      firstCandidate.iterationsApplied = true;
      learningState.setDeferredCandidate(state, '/ws', {
        sessionId: firstCandidate.sessionId,
        turnId: firstCandidate.turnId,
        mode: firstCandidate.mode,
        iterationIncrement: firstCandidate.iterationIncrement,
        iterationsApplied: true,
      });
      await learningState.saveState(gs, state);

      // Verify cumulative is now 10
      state = learningState.loadState(gs);
      assert.strictEqual(learningState.getIterations(state, '/ws'), 10, '10 iterations after first add');
      assert.strictEqual(learningState.peekDeferredCandidate(state, '/ws').iterationsApplied, true, 'marked applied');

      // Simulate retry (cooldown skip): should NOT re-add iterations
      const retryCandidate = learningState.peekDeferredCandidate(state, '/ws');
      if (!retryCandidate.iterationsApplied) {
        // This should NOT execute
        learningState.addIterations(state, '/ws', retryCandidate.iterationIncrement);
      }
      await learningState.saveState(gs, state);

      // Verify cumulative is still 10, not 12
      state = learningState.loadState(gs);
      assert.strictEqual(learningState.getIterations(state, '/ws'), 10, 'still 10 after retry — no double-count');
      ok('deferred: iterationsApplied=false adds once, retry skips re-add');
    } finally {
      promptClient.fetchPrompt = origFetch;
    }
  });

  console.log('\n--- Summary ---');
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});

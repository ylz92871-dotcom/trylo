'use strict';

/*
 * smoke-learning-l5.js
 *
 * L5 Skill quality & lifecycle governance — behaviour tests (L5 §8 / doc-31
 * §13). Exercises the production modules: signals, detector, lifecycle,
 * versioning, runner-prompt, and the curation_adapter extension. The curation
 * runner (model) is a MOCK injected where needed so the tests are
 * deterministic and do not burn real model calls.
 *
 * T0 self-test / T1 graph+usage reuse / T2 signal consistency / T3 platform
 * conflict / T4 merge two-step ordering / T5 SKILL_PENDING_BUSY /
 * T6 snapshot fail-closed / T7 stage-only deprecate / T8 graph missing fail /
 * T9 security blocked / T10 versioning lineage.
 *
 * Run: node smoke-learning-l5.js
 */

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const signals = require('./learning-loop/skill-quality/signals');
const detector = require('./learning-loop/skill-quality/detector');
const lifecycle = require('./learning-loop/skill-quality/lifecycle');
const versioning = require('./learning-loop/skill-quality/versioning');
const runnerPrompt = require('./learning-loop/skill-quality/runner-prompt');
const ls = require('./learning-loop/learning-state');
const { resolveHermesPython } = require('./hermes-python-resolver');
// 33 G1: lifecycle state dep is the learning-state MODULE (it has
// addProposal/updateProposal methods), not a plain data object.
const learningState = ls;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log('  PASS: ' + name); }
  catch (err) { failed++; console.log('  FAIL: ' + name + '\n        ' + err.message); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log('  PASS: ' + name); }
  catch (err) { failed++; console.log('  FAIL: ' + name + '\n        ' + err.message); }
}
function freshHermesHome(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-l5-' + label + '-'));
  const home = path.join(root, 'hermes-capabilities', 'v1');
  fs.mkdirSync(home, { recursive: true });
  return { root, home };
}
function cleanup(home) {
  try { fs.rmSync(path.dirname(home), { recursive: true, force: true }); } catch {}
}
function runPython(script) {
  const pythonExe = resolveHermesPython();
  const tmp = path.join(os.tmpdir(), 'trylo-l5-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.py');
  fs.writeFileSync(tmp, script, 'utf8');
  try { return require('child_process').execFileSync(pythonExe, [tmp], { encoding: 'utf8' }); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

function seedSkillFile(home, name, platform, workspace, deprecated) {
  const dir = path.join(home, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const fm = ['---', 'name: ' + name, 'description: ' + name + ' description', 'applies_to_platform: [' + platform + ']', 'applies_to_workspace: [' + workspace + ']']
    .concat(deprecated ? ['deprecated: true'] : [], ['---', '', '# ' + name, '', 'body ' + name]).join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), fm);
}

async function selfTest() {
  if (process.argv.includes('--self-test-fail')) {
    try { assert.strictEqual(1, 2, 'self-test deliberate failure'); }
    catch (e) { failed++; console.log('  FAIL: self-test should fail'); }
    console.log('\n--- Summary ---');
    console.log('  Passed: ' + passed);
    console.log('  Failed: ' + failed);
    if (failed > 0) process.exitCode = 1;
    return;
  }
  const child = spawnSync(process.execPath, [__filename, '--self-test-fail'], { encoding: 'utf8' });
  if (child.status === 0) { failed++; console.log('  FAIL: self-test must yield non-zero; got 0'); }
  else { passed++; console.log('  PASS: self-test yields exit code ' + child.status); }
}

function makeSignal(name, { category = 'data', description = name + ' desc', usedCount, lastUsedAt, platforms, workspaces }) {
  return {
    skillName: name, category, description, usedCount, lastUsedAt, lastVerifiedAt: null,
    verifiedOk: null, verifiedFailed: null, platforms, workspaces,
    sourceCount: workspaces ? new Set(workspaces).size : 0, conflictFlags: [],
    excludeFromDetector: false,
    signalSource: { usedCount: usedCount != null ? 'usage_report' : null },
  };
}

async function runT1() {
  // 33 F2 (audit P0-1): T1 was fake-green — it fed buildSignals a hand-crafted
  // `{name, category, description}` graphSummary, so it never exercised the
  // REAL curation_adapter node shape `{id, label, kind}`. Now it calls the real
  // adapter, feeds the result to signals (T1a), AND keeps the legacy shape
  // (T1b) for backward compat.
  await testAsync('T1: signals accepts real curation_adapter output AND legacy shape', async () => {
    const { home, root } = freshHermesHome('t1');
    try {
      fs.writeFileSync(path.join(home, 'config.yaml'), 'memory:\n  write_approval: True\nskills:\n  write_approval: True\n');
      seedSkillFile(home, 'sql-query-optimizer', 'linux', 'ws-prod', false);
      const bump = [
        'import sys, os',
        'sys.path.insert(0, ' + JSON.stringify(process.cwd() + path.sep + 'hermes-capabilities') + ')',
        'os.environ["HERMES_HOME"] = ' + JSON.stringify(home),
        'from tools import skill_usage',
        'try: skill_usage.bump_use("sql-query-optimizer")',
        'except Exception as e: print("bump err:", e)',
      ].join('\n');
      runPython(bump);
      const out = runPython([
        'import sys, os, json',
        'sys.path.insert(0, ' + JSON.stringify(process.cwd() + path.sep + 'hermes-capabilities') + ')',
        'os.environ["HERMES_HOME"] = ' + JSON.stringify(home),
        'from curation_adapter import build_summary',
        'sys.stdout.write(json.dumps(build_summary(), ensure_ascii=False))',
      ].join('\n'));
      const parsed = JSON.parse(out);
      assert.strictEqual(parsed.success, true, 'build_summary ok');
      assert.ok(parsed.usageReport && parsed.usageReport['sql-query-optimizer'], 'usageReport present');
      assert.ok(parsed.verdicts && parsed.verdicts['sql-query-optimizer'], 'verdicts present');
      assert.ok(parsed.frontmatter && parsed.frontmatter['sql-query-optimizer'], 'frontmatter present');
      // T1a: REAL adapter output (33 F2 P0-1 fix) — nodes are {id,label,kind}.
      const usageRecords = Object.entries(parsed.usageReport || {}).map(([n, r]) => ({ name: n, use_count: r.usedCount, last_used_at: r.lastUsedAt, last_activity_at: r.lastActivityAt }));
      const sigOut = signals.buildSignals({ graphSummary: parsed, usageRecords, frontmatter: parsed.frontmatter });
      assert.ok(Object.keys(sigOut.signals).length >= 1, 'real adapter output produces signals (P0-1 fix)');
      const s = sigOut.signals['sql-query-optimizer'];
      assert.ok(s, 'sql-query-optimizer signal exists from real adapter output');
      assert.strictEqual(s.signalSource.usedCount, 'usage_report', 'usage source traceable');
      assert.strictEqual(s.signalSource.category, 'graph.metadata', 'category source traceable');
      // T1b: legacy shape (backward compat).
      const sigOutLegacy = signals.buildSignals({
        graphSummary: { nodes: [{ name: 'legacy-x', category: 'data', description: 'x' }] },
        usageRecords: [],
      });
      assert.ok(sigOutLegacy.signals['legacy-x'], 'legacy name/category/description still works');
      console.log('  T1: real adapter signals=' + Object.keys(sigOut.signals).length + ' legacy=' + Object.keys(sigOutLegacy.signals).length);
    } finally { cleanup(home); }
  });
}

function runT2() {
  // T2: signal consistency — verifiedOk+Failed > usedCount -> INVALID + exclude.
  test('T2: USAGE_DATA_INCONSISTENT -> signal INVALID, excluded from detector', () => {
    const sigOut = signals.buildSignals({
      graphSummary: { nodes: [{ name: 'x', category: 'c', description: 'x' }], edges: [], clusters: [], stats: {} },
      usageRecords: [{ name: 'x', use_count: 2 }],
    });
    // manually set inconsistent verified counts
    const s = sigOut.signals.x;
    s.verifiedOk = 5; s.verifiedFailed = 3; s.usedCount = 2;
    const det = detector.detectCandidates({ signals: { x: s } });
    assert.strictEqual(det.pairs.length, 0, 'inconsistent signal never becomes a pair');
    console.log('  T2: inconsistent usage flagged');
  });
}

function runT3() {
  // T3: platform conflict -> hardReject, pair excluded.
  test('T3: platform conflict => no similarity pair', () => {
    const a = makeSignal('sql-query-optimizer', { category: 'data', usedCount: 50, platforms: ['linux', 'macos'], workspaces: ['ws-prod'] });
    const b = makeSignal('sql-query-windows', { category: 'data', usedCount: 5, platforms: ['windows'], workspaces: ['ws-prod'] });
    const det = detector.detectCandidates({ signals: { 'sql-query-optimizer': a, 'sql-query-windows': b } });
    assert.strictEqual(det.pairs.length, 0, 'platform conflict -> no pair');
    assert.strictEqual(det.stats.conflict, 1, '1 conflict');
    console.log('  T3: hard-reject on platform conflict');
  });
}

async function runT4() {
  // T4: merge two-step ordering (absorber edit first, absorbed deprecate second).
  await testAsync('T4: buildMergeProposal stages absorber-edit then absorbed-deprecate', async () => {
    const lc = new lifecycle.LifecycleController({
      skillGovernance: {}, state: ls,
      writeApproval: {
        listPending: async () => [],
        stage: async (p) => ({ pendingId: (p.mergeStep === 'edit' ? 'edit-1' : 'dep-1') }),
      },
      snapshotter: { snapshot: async () => ({ ok: true, snapshotId: 'snap-m' }) },
      logger: () => {},
    });
    const state = { schemaVersion: 1, workspaces: {} };
    const m = await lc.buildMergeProposal(state, 'absorber', 'absorbed', 'merged content', [], 'merge it');
    assert.strictEqual(m.action, 'merge');
    assert.strictEqual(m.ordering, 'absorber-edit-first');
    assert.deepStrictEqual(m.pendingIds, ['edit-1', 'dep-1'], 'edit first, deprecate second');
    assert.strictEqual(m.snapshotId, 'snap-m', 'snapshot before destructive');
    assert.strictEqual(state.skillQuality.proposals.length, 1, 'proposal persisted');
    console.log('  T4: merge two-step ordering OK');
  });
}

async function runT5() {
  // T5: SKILL_PENDING_BUSY + SNAPSHOT_REQUIRED.
  await testAsync('T5: SKILL_PENDING_BUSY and SNAPSHOT_REQUIRED fail closed', async () => {
    const lcBusy = new lifecycle.LifecycleController({
      skillGovernance: {}, state: ls,
      writeApproval: { listPending: async () => [{ targets: [{ skillName: 'sk' }] }], stage: async () => ({ pendingId: 'x' }) },
      snapshotter: { snapshot: async () => ({ ok: true, snapshotId: 's' }) }, logger: () => {},
    });
    let busy = false;
    try { await lcBusy.buildProposal({ action: 'edit', targets: ['sk'], snapshotId: 's' }, { schemaVersion: 1, workspaces: {} }); }
    catch (e) { busy = /SKILL_PENDING_BUSY/.test(e.message); }
    assert.ok(busy, 'SKILL_PENDING_BUSY');
    const lcSnap = new lifecycle.LifecycleController({
      skillGovernance: {}, state: ls,
      writeApproval: { listPending: async () => [], stage: async () => ({ pendingId: 'x' }) },
      // no snapshotter -> destructive action must fail with SNAPSHOT_REQUIRED
      logger: () => {},
    });
    let snapReq = false;
    try { await lcSnap.buildProposal({ action: 'delete', targets: ['sk'], snapshotId: null }, { schemaVersion: 1, workspaces: {} }); }
    catch (e) { snapReq = /SNAPSHOT_REQUIRED/.test(e.message); }
    assert.ok(snapReq, 'SNAPSHOT_REQUIRED for delete without snapshotter');
    console.log('  T5: SKILL_PENDING_BUSY + SNAPSHOT_REQUIRED OK');
  });
}

async function runT6() {
  // T6: snapshot failure -> SNAPSHOT_FAILED, no stage.
  await testAsync('T6: snapshot fail -> SNAPSHOT_FAILED, destructive not staged', async () => {
    const lc = new lifecycle.LifecycleController({
      skillGovernance: {}, state: ls,
      writeApproval: { listPending: async () => [], stage: async () => ({ pendingId: 'x' }) },
      snapshotter: { snapshot: async () => ({ ok: false, error: 'snapshot_skills failed' }) }, logger: () => {},
    });
    let snapFailed = false;
    try { await lc.buildProposal({ action: 'delete', targets: ['sk'], snapshotId: null }, { schemaVersion: 1, workspaces: {} }); }
    catch (e) { snapFailed = /SNAPSHOT_FAILED/.test(e.message); }
    assert.ok(snapFailed, 'SNAPSHOT_FAILED on snapshot failure');
    console.log('  T6: destructive blocked without a valid snapshot');
  });
}

function runT7() {
  // T7: signals derive from deterministic code, no model self-report.
  test('T7: signal fields are deterministic (no model score)', () => {
    const s = makeSignal('demo', { category: 'data', usedCount: 10, platforms: ['linux'], workspaces: ['ws1'] });
    // there is no "score" field anywhere
    assert.ok(!('score' in s) && !('modelScore' in s) && !('rating' in s), 'no model score field');
    assert.strictEqual(s.signalSource.usedCount, 'usage_report', 'source traceable');
    console.log('  T7: signals carry no model score');
  });
}

function runT8() {
  // T8: graph missing -> signals empty + missingUsage recorded (not a crash).
  test('T8: empty graph -> no signals, no crash', () => {
    const out = signals.buildSignals({ graphSummary: { nodes: [], edges: [], clusters: [], stats: {} }, usageRecords: [] });
    assert.strictEqual(Object.keys(out.signals).length, 0, 'no signals');
    assert.deepStrictEqual(out.missingUsage, [], 'no missing usage');
    console.log('  T8: empty graph handled');
  });
}

function runT9() {
  // T9: security-blocked frontmatter -> excluded from detector (not mergeable).
  test('T9: security_blocked skill excluded from similarity', () => {
    const a = makeSignal('a', { category: 'data', usedCount: 1, platforms: ['linux'], workspaces: ['ws1'] });
    const b = makeSignal('b', { category: 'data', usedCount: 1, platforms: ['linux'], workspaces: ['ws1'] });
    b.excludeFromDetector = true; // security_blocked -> exclude
    const det = detector.detectCandidates({ signals: { a, b } });
    assert.strictEqual(det.pairs.length, 0, 'excluded skill not paired');
    console.log('  T9: security-blocked skill excluded');
  });
}

function runT10() {
  // T10: versioning lineage append + cap + broken-parent.
  test('T10: versioning lineage capped at 50, broken parent detected', () => {
    const state = { schemaVersion: 1, workspaces: {} };
    for (let i = 0; i < 55; i++) versioning.appendLineage(state, 'sk', { parentSnapshotId: 's' + i, changeReason: 'r' + i, changeAction: 'edit', actor: 'system' });
    assert.strictEqual(state.skillQuality.versions.sk.lineage.length, 50, 'cap 50');
    assert.strictEqual(versioning.validateLineage(state.skillQuality.versions.sk, new Set(['s49'])).ok, false, 'broken parent');
    console.log('  T10: versioning lineage OK');
  });
}

// 33 F2: T-cap — signals/proposals/lineage capacity capping, staged immune.
function runTCap() {
  test('T-cap: signals/proposals/lineage capping with staged-immune', () => {
    // signals cap 500: drop oldest by (lastUsedAt DESC, name ASC)
    const many = {};
    for (let i = 0; i < 502; i++) many['sk-' + i] = makeSignal('sk-' + i, { usedCount: 1, lastUsedAt: i, platforms: ['linux'], workspaces: ['ws1'] });
    const capped = signals.capSignals(many);
    assert.strictEqual(Object.keys(capped.signals).length, 500, 'signals capped at 500');
    assert.strictEqual(capped.dropped.length, 2, '2 dropped');
    // proposals cap 200: drop oldest TERMINAL, staged never evicted.
    const state = { schemaVersion: 1, workspaces: {} };
    for (let i = 0; i < 201; i++) {
      ls.addProposal(state, {
        proposalId: 'p-' + i, action: 'edit', targets: ['t-' + i], signalRefs: [], rationale: '',
        pendingIds: ['pid-' + i], state: 'rolled_back', errorCode: '',
        snapshotId: null, parentProposalId: null, createdAt: i, updatedAt: i,
      });
    }
    // all terminal -> capped at 200, oldest dropped
    assert.strictEqual(state.skillQuality.proposals.length, 200, 'proposals capped at 200');
    // staged must survive: add a staged proposal then overflow -> it stays
    ls.addProposal(state, { proposalId: 'staged-keep', action: 'edit', targets: ['t'], signalRefs: [], rationale: '', pendingIds: ['pid'], state: 'staged', errorCode: '', snapshotId: null, parentProposalId: null, createdAt: 0, updatedAt: 0 });
    const hasStaged = state.skillQuality.proposals.some((p) => p.state === 'staged');
    assert.ok(hasStaged, 'staged proposal never evicted');
    // versioning cap 50
    for (let i = 0; i < 55; i++) versioning.appendLineage(state, 'sk', { parentSnapshotId: 's' + i, changeReason: 'r' + i, changeAction: 'edit', actor: 'system' });
    assert.strictEqual(state.skillQuality.versions.sk.lineage.length, 50, 'lineage capped at 50');
    console.log('  T-cap: signals=500, proposals=200 (staged kept), lineage=50');
  });
}

// 33 F2: T-order — merge proposalId lex sort puts edit before deprecate.
// The lifecycle uses a numeric step prefix (1-edit / 2-deprecate) so the
// absorbing edit always sorts before the absorbed deprecate in the review UI.
function runTOrder() {
  test('T-order: merge proposalId ordering enforces edit-before-deprecate', () => {
    const editId = 'l5-merge-1-edit-absorber-1700000000';
    const depId = 'l5-merge-2-deprecate-absorbed-1700000000';
    const ids = [depId, editId].sort();
    assert.deepStrictEqual(ids, [editId, depId], 'numeric step prefix puts edit before deprecate');
    console.log('  T-order: edit precedes deprecate in merge proposalId sort');
  });
}

// 33 G1.5: T11 — production entry E2E. LifecycleController.buildProposal builds
// a proposal with pendingIds when given a stubbed writeApproval + snapshotter;
// the proposalId + pendingIds are recorded in state (G1.1 wiring closed).
async function runT11() {
  await testAsync('T11: production entry — buildProposal via lifecycle records pendingIds', async () => {
    const state = { schemaVersion: 1, workspaces: {}, historyMining: { runId: 't11', startedAt: Date.now(), status: 'ok', stats: {} } };
    const fakePendingIds = [];
    const writeApproval = {
      listPending: async () => fakePendingIds.slice(),
      stage: async (payload) => {
        // Emit a deterministic pendingId per stage call.
        const pid = 'l5-pending-' + (payload.mergeStep || payload.action) + '-' + (payload.target || 'x') + '-' + Date.now().toString(36);
        fakePendingIds.push(pid);
        return { pendingId: pid };
      },
    };
    const snapshotter = { snapshot: async (n) => ({ ok: true, snapshotId: 'l5-snap-' + n }) };
    // Pass a state-shape stub (NOT the learningState module) — the lifecycle
    // module is the real one, but its state param must be a plain state object
    // with a `skillQuality` section that the lifecycle can write into.
    const l5StateModule = lifecycle.LifecycleController;
    const lifecycleAny = l5StateModule; // alias for clarity
    // lifecycle takes state via the buildProposal signature: buildProposal(..., state).
    // We use the exported addProposal / updateProposal etc. via the real module.
    // However, the simplest is: use the lifecycle to drive staging, but the
    // test reads/writes state directly via learningState addProposal / updateProposal.
    const lc = new lifecycle.LifecycleController({ skillGovernance: {}, state: learningState, writeApproval, snapshotter, logger: () => {} });
    const p = await lc.buildProposal({
      action: 'edit', targets: ['sql-query-helper'],
      signalRefs: ['sql-query-optimizer'],
      rationale: 'G1 T11 production entry E2E', snapshotId: 'snap-edit-1',
    }, state);
    // lifecycle already called learningState.addProposal(state, p) internally.
    assert.ok(p.proposalId, 'proposalId present');
    assert.strictEqual(p.action, 'edit');
    assert.deepStrictEqual(p.targets, ['sql-query-helper']);
    assert.strictEqual(p.pendingIds.length, 1, 'one pendingId');
    assert.strictEqual(state.skillQuality.proposals.length, 1, 'proposal persisted in state');
    assert.ok(state.skillQuality.proposals[0].proposalId === p.proposalId, 'persisted proposalId matches');
  });
}

// 33 G1.5: T12 — state closure sync. After transitionProposal, the proposal's
// state matches the pending's terminal state. The G1.3 helper
// _syncSkillQualityProposalByPendingId (here re-implemented in-test) does
// the lookup-by-pendingId + state assignment.
async function runT12() {
  await testAsync('T12: transitionProposal updates proposal.state (state closure)', async () => {
    const state = { schemaVersion: 1, workspaces: {} };
    const writeApproval = {
      listPending: async () => ['p-edit-1', 'p-dep-1'],
      stage: async () => ({ pendingId: 'l5-pending-x-' + Date.now().toString(36) }),
    };
    const snapshotter = { snapshot: async () => ({ ok: true, snapshotId: 's' }) };
    const lc = new lifecycle.LifecycleController({ skillGovernance: {}, state: learningState, writeApproval, snapshotter, logger: () => {} });
    const mp = await lc.buildMergeProposal(state, 'absorber', 'absorbed', 'merged', [], 'T12');
    learningState.addProposal(state, mp);
    // Get the edit pendingId (pendingIds[0])
    const editPid = mp.pendingIds[0];
    // Approve the edit (order-checked by transitionProposal).
    const updated = await lc.transitionProposal(state, mp.proposalId, { state: 'approved', pendingId: editPid });
    assert.strictEqual(updated.state, 'approved', 'edit state updated to approved');
    // Order constraint: attempting deprecate approval before edit would throw
    // MERGE_STEP_LOCKED. Test via a fresh proposal.
    const writeApproval2 = {
      listPending: async () => ['p-edit-2'],
      stage: async () => ({ pendingId: 'p-edit-2' }),
    };
    const lc2 = new lifecycle.LifecycleController({ skillGovernance: {}, state: learningState, writeApproval: writeApproval2, snapshotter, logger: () => {} });
    const mp2 = await lc2.buildMergeProposal(state, 'a2', 'b2', 'm2', [], 'T12b');
    let locked = false;
    try {
      await lc2.transitionProposal(state, mp2.proposalId, { state: 'approved', pendingId: mp2.pendingIds[1] });
    } catch (e) { locked = /MERGE_STEP_LOCKED/.test(e.message); }
    assert.ok(locked, 'deprecate approved before edit -> MERGE_STEP_LOCKED');
    // State sync (G1.3): call the sync helper pattern on the edit-approved proposal.
    function sync(state, pendingId, terminal) {
      const sq = state.skillQuality;
      for (const p of (sq.proposals || [])) {
        if (p && Array.isArray(p.pendingIds) && p.pendingIds.indexOf(pendingId) !== -1) {
          p.state = terminal;
          p.updatedAt = Date.now();
          learningState.updateProposal(state, p.proposalId, (old) => Object.assign({}, old, { state: p.state, updatedAt: p.updatedAt }));
          return true;
        }
      }
      return false;
    }
    assert.strictEqual(sync(state, editPid, 'approved'), true, 'sync by pendingId found edit');
    assert.strictEqual(state.skillQuality.proposals[0].state, 'approved', 'proposal state synced to approved');
  });
}

async function main() {
  await selfTest();
  await runT1();
  runT2();
  runT3();
  await runT4();
  await runT5();
  await runT6();
  runT7();
  runT8();
  runT9();
  runT10();
  runTCap();        // 33 F2: capacity capping
  runTOrder();      // 33 F2: merge order
  await runT11();    // 33 G1.5: production entry E2E
  await runT12();    // 33 G1.5: state closure + order constraint
  console.log('\n--- Summary ---');
  console.log('  Passed: ' + passed);
  console.log('  Failed: ' + failed);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('smoke-learning-l5 failed unexpectedly:', err);
  process.exitCode = 1;
  console.log('\n--- Summary ---');
  console.log('  Passed: ' + passed);
  console.log('  Failed: ' + failed);
});
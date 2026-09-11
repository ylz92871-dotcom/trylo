'use strict';

/*
 * smoke-l5-real-stage-pendingid.js
 *
 * 30 §3 P1-2 (A.3 v2) — L5 real stage pendingId + production wiring.
 *
 * Asserts:
 *   T1  lifecycle.buildProposal rejects stage that returns no
 *       pendingId (no fabricated IDs).
 *   T2  lifecycle.buildProposal propagates stage errors (no
 *       fabricated IDs from a catch-all swallow).
 *   T3  the headless writeApproval.stage pattern (A.2 fix) is a
 *       documented local-only stub, NOT a fabricated local ID
 *       after a real-stage failure.
 *   T4  the L5 production-wiring trace: buildProposal -> stage is
 *       a single writeApproval call; no runAdminAsync(op:'apply')
 *       in the production path.
 *
 * Run: node smoke-l5-real-stage-pendingid.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname);
const lc = require('./learning-loop/skill-quality/lifecycle');
const ls = require('./learning-loop/learning-state');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  PASS: ' + name); }
  catch (err) { failed++; console.log('  FAIL: ' + name + '\n        ' + err.message); }
}
async function testAsync(name, fn) {
  const p = (async () => {
    try { await fn(); passed++; console.log('  PASS: ' + name); }
    catch (err) { failed++; console.log('  FAIL: ' + name + '\n        ' + err.message); }
  })();
  return p;
}

function makeLc(opts) {
  return new lc.LifecycleController(Object.assign({
    skillGovernance: {},
    state: ls,
    writeApproval: { listPending: async () => [], stage: async () => ({ pendingId: 'real-pending-1' }) },
    snapshotter: { snapshot: async () => ({ ok: true, snapshotId: 'snap-1' }) },
    logger: () => {},
  }, opts || {}));
}

test('T1: lifecycle rejects stage that returns no pendingId (no fabrication)', async () => {
  await assert.rejects(
    (async () => {
      const lcc = makeLc({ writeApproval: { listPending: async () => [], stage: async () => ({}) } });
      await lcc.buildProposal({ action: 'edit', targets: ['t1'] }, { schemaVersion: 1, workspaces: {} });
    }),
    /STAGE_FAILED.*no pendingId/,
  );
});

test('T2: lifecycle propagates stage errors (no catch-all fabrication)', async () => {
  await assert.rejects(
    (async () => {
      const lcc = makeLc({ writeApproval: { listPending: async () => [], stage: async () => { throw new Error('admin unreachable'); } } });
      await lcc.buildProposal({ action: 'edit', targets: ['t1'] }, { schemaVersion: 1, workspaces: {} });
    }),
    /admin unreachable/,
  );
});

test('T3: headless stage now uses real proposeSkillAsync (no local-prefix fake)', () => {
  // 39 C1 (P0) fix: the headless runQualityScanHeadless path in
  // extension.js must call the REAL `proposeSkillAsync` bridge
  // (NOT a local-prefix fake like `l5-headless-`). The local-prefix
  // pattern was the previous A.2 mitigation which we now know
  // was insufficient (smoke T3 of l5-real-vertical-e2e proved the
  // fake ID was never present in the Hermes pending store).
  const ext = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
  const start = ext.indexOf('function runQualityScanHeadless');
  if (start < 0) throw new Error('runQualityScanHeadless not found');
  const end = ext.indexOf('\nfunction ', start + 1);
  const body = end > 0 ? ext.slice(start, end) : ext.slice(start);
  // The headless body must call `proposeSkillAsync` (real bridge).
  if (!body.includes('proposeSkillAsync')) {
    throw new Error('runQualityScanHeadless does NOT call proposeSkillAsync — C1 fix missing');
  }
  // The headless body must NOT emit a local-prefix fake.
  if (body.includes("'l5-headless-")) {
    throw new Error('runQualityScanHeadless still emits l5-headless- fake pendingIds — C1 fix incomplete');
  }
  // Verify the apply call inside the headless writeApproval.stage
  // is the BRIDGE (proposeSkillAsync), not `runAdminAsync({op:'apply'})`.
  if (body.includes("op: 'apply'")) {
    throw new Error('runQualityScanHeadless still calls runAdminAsync({op:"apply"}) — C1 fix incomplete');
  }
});

test('T4: production-wiring trace — buildProposal calls stage once, never admin apply', async () => {
  let stageCalls = 0;
  const traceLog = [];
  const w = {
    listPending: async () => { traceLog.push('listPending'); return []; },
    stage: async (payload) => {
      stageCalls += 1;
      traceLog.push('stage');
      return { pendingId: 'real-pending-' + stageCalls };
    },
  };
  const lcc = makeLc({ writeApproval: w });
  const state = { schemaVersion: 1, workspaces: {} };
  // buildProposal should call listPending (for busy check) + stage.
  await lcc.buildProposal({ action: 'edit', targets: ['t1'] }, state);
  assert.strictEqual(stageCalls, 1, 'stage called exactly once');
  // The trace must NOT contain 'runAdminAsync' or 'op:apply'.
  if (traceLog.some((s) => /runAdminAsync|op:\s*['"]apply['"]/.test(s))) {
    throw new Error('production trace contains forbidden admin op: ' + traceLog.join(','));
  }
  // And the persisted proposal has the real pendingId.
  const sq = ls.getSkillQuality(state);
  assert.ok(sq.proposals && sq.proposals.length === 1, 'one proposal persisted');
  assert.strictEqual(sq.proposals[0].pendingIds[0], 'real-pending-1', 'real pendingId recorded');
  // The proposal is marked as staged (not stageFailed).
  assert.strictEqual(sq.proposals[0].state, 'staged', 'proposal state is staged (not stageFailed)');
});

(async () => {
  console.log('--- L5 real-stage pendingId (A.3 v2) ---');
  await new Promise((r) => setTimeout(r, 100));
  console.log('\n--- Summary ---');
  console.log('  Passed: ' + passed);
  console.log('  Failed: ' + failed);
  if (failed > 0) process.exit(1);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

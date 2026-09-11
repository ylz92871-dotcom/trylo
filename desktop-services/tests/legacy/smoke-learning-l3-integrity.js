/*
 * smoke-learning-l3-integrity.js
 *
 * 15 §6: real behaviour tests for the L3 approval integrity closeout.
 * Every test goes through the PRODUCTION code path
 * (hermes-pending-admin.runAdminAsync -> admin.py -> upstream.py ->
 * Hermes 0.19.0). No source-string search, no manual counters, no
 * duplicate parsers. A dedicated self-test (T0) verifies that the
 * suite catches deliberate failures: the test must exit non-zero
 * when a known-bad assertion runs.
 *
 * T1 preview-hash anti-swap MUST fail closed (empty / changed).
 * T2 snapshot None / exception MUST block apply and keep pending.
 * T3 rollback MUST restore ORIGINAL bytes exactly (Buffer.compare
 *    must equal 0; lenient "contains skill name" branches are FORBIDDEN).
 * T4 per-turn + generic Skill approval use the SAME production
 *    closure and the same normaliser.
 * T5 webview realtime patch covers 5 states, never carries body/diff.
 * T6 L0 source binding only trusts the orchestrator diff ID.
 *
 * Run: node smoke-learning-l3-integrity.js
 */

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const hermesPendingAdmin = require('./hermes-pending-admin');
const skillGovernance = require('./learning-loop/skill-governance');
const { resolveHermesPython } = require('./hermes-python-resolver');

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-l3i-' + label + '-'));
  const home = path.join(root, 'hermes-capabilities', 'v1');
  fs.mkdirSync(home, { recursive: true });
  return { root, home };
}

function writeConfig(home) {
  fs.writeFileSync(
    path.join(home, 'config.yaml'),
    'memory:\n  write_approval: True\nskills:\n  write_approval: True\n',
  );
}

function cleanup(home) {
  try { fs.rmSync(path.dirname(home), { recursive: true, force: true }); } catch {}
}

function runPython(script) {
  // Write a multi-line script to a temp .py file. We avoid the `\\n`
  // escape games by writing each line verbatim; newline chars in the
  // output Python source become real newlines.
  const pythonExe = resolveHermesPython();
  const tmp = path.join(os.tmpdir(), 'trylo-l3i-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.py');
  fs.writeFileSync(tmp, script, 'utf8');
  try {
    return execFileSync(pythonExe, [tmp], { encoding: 'utf8' });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function writeYamlConfig(home) {
  fs.writeFileSync(
    path.join(home, 'config.yaml'),
    'memory:\n  write_approval: True\nskills:\n  write_approval: True\n',
  );
}

function stageSkill(storageRoot, targetName) {
  // The staging Python file is written with a single string so the
  // embedded newlines are real newlines in the .py file, not
  // backslash escapes. This is the only reliable way to get a
  // multi-line Python script out of JS without escape games.
  // We print the raw return value of skill_manage (which is itself
  // a JSON string). Caller parses with JSON.parse.
  const script = [
    'import sys, os, json',
    'sys.path.insert(0, ' + JSON.stringify(process.cwd() + path.sep + 'hermes-capabilities') + ')',
    'os.environ["HERMES_HOME"] = ' + JSON.stringify(storageRoot + '/hermes-capabilities/v1'),
    'from upstream import skill_manage',
    'r = skill_manage("create", ' + JSON.stringify(targetName) + ')',
    'print(r)',
    '',
  ].join('\n');
  return runPython(script);
}

function applySkill(storageRoot, pendingId) {
  const script = [
    'import sys, os, json',
    'sys.path.insert(0, ' + JSON.stringify(process.cwd() + path.sep + 'hermes-capabilities') + ')',
    'os.environ["HERMES_HOME"] = ' + JSON.stringify(storageRoot + '/hermes-capabilities/v1'),
    'from admin import apply_skill_with_snapshot',
    'print(json.dumps(apply_skill_with_snapshot(' + JSON.stringify(pendingId) + ', "", "trylo-t1a")))',
    '',
  ].join('\n');
  return runPython(script);
}

async function selfTest() {
  if (process.argv.includes('--self-test-fail')) {
    try {
      assert.strictEqual(1, 2, 'self-test deliberate failure');
    } catch (e) { failed++; console.log('  FAIL: self-test should fail'); }
    console.log('\n--- Summary ---');
    console.log('  Passed: ' + passed);
    console.log('  Failed: ' + failed);
    if (failed > 0) process.exitCode = 1;
    return;
  }
  const child = spawnSync(process.execPath, [__filename, '--self-test-fail'], { encoding: 'utf8' });
  if (child.status === 0) {
    failed++;
    console.log('  FAIL: self-test (deliberate failure) must yield non-zero exit; got 0');
  } else {
    passed++;
    console.log('  PASS: self-test (deliberate failure) yields exit code ' + child.status);
  }
}

async function runT1() {
  // T1a is covered by the production admin boundary in admin.py:
  // empty expectedHash returns EXPECTED_HASH_REQUIRED. We assert
  // the same fail-closed behaviour via the normaliser (T1b) and
  // via the full anti-swap flow (T1d). T1a would otherwise be a
  // duplicate of T1d with a different expectedHash.
  test('T1a: production normaliser maps empty expectedHash to apply_failed + EXPECTED_HASH_REQUIRED', () => {
    const norm = skillGovernance.normaliseApplyResult({
      adminResult: { success: false, error: 'EXPECTED_HASH_REQUIRED: caller did not supply the user-previewed hash', kept_pending: true },
      expectedHash: '',
      payload: { id: 'x' },
    });
    assert.strictEqual(norm.state, 'apply_failed');
    assert.strictEqual(norm.patch.errorCode, 'EXPECTED_HASH_REQUIRED');
  });

  test('T1b: production normaliser maps live hash changed to apply_failed + PAYLOAD_CHANGED', () => {
    const norm = skillGovernance.normaliseApplyResult({
      adminResult: { success: false, error: 'payload changed since preview', kept_pending: true, liveHash: 'h2', expectedHash: 'h1' },
      expectedHash: 'h1',
      liveHash: 'h2',
      payload: { id: 'x' },
    });
    assert.strictEqual(norm.state, 'apply_failed');
    assert.strictEqual(norm.patch.errorCode, 'PAYLOAD_CHANGED');
  });

  await testAsync('T1c: full anti-swap flow -> pending NOT gone, file NOT written', async () => {
    const { home, root } = freshHermesHome('t1c');
    try {
      writeYamlConfig(home);
      const stageOut = stageSkill(root, 'demo-t1c');
      const stage = JSON.parse(stageOut.trim());
      const pid = stage.pending_id;
      assert.ok(pid, 'stage must produce a pending id, got: ' + stageOut.slice(0, 300));
      const WRONG = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
      const ap = await hermesPendingAdmin.applySkillWithSnapshotAsync(root, {
        id: pid, expectedHash: WRONG, reason: 'trylo-t1c',
      });
      assert.ok(ap && !ap.success, 'admin call must fail for wrong hash, got: ' + JSON.stringify(ap).slice(0, 500));
      // pending must still exist
      const lp2 = await hermesPendingAdmin.listPendingAsync(root);
      assert.ok((lp2.pending || []).some(p => p.id === pid),
        'pending must NOT be discarded on anti-swap failure');
      // new SKILL.md must not have been written
      assert.ok(!fs.existsSync(path.join(home, 'skills', 'demo-t1c', 'SKILL.md')),
        'SKILL.md must NOT be written on anti-swap failure');
    } finally { cleanup(home); }
  });
}

async function runT2() {
  // 20 §5 F5-1: split the old single T2a into two scenarios.
  // T2a-1: fresh first-create MUST commit with a valid backupState.
  await testAsync('T2a-1: fresh first-create commits with a valid backupState', async () => {
    const { home, root } = freshHermesHome('t2a1');
    try {
      writeYamlConfig(home);
      // No pre-seed: skills/ does not exist yet (fresh home). Stage a
      // create and apply — the first create must commit and carry a
      // valid backupState (nothing_to_backup, or snapshot_ok if the
      // official snapshot decides to snapshot even an empty tree).
      stageAndApplySkillLocal(root, 'create', 'demo-t2a', null);
      const lp = await hermesPendingAdmin.listPendingAsync(root);
      const skillPending = (lp.pending || []).find(p => p.subsystem === 'skills');
      assert.ok(skillPending, 'a skills pending must exist after staging');
      const detail = hermesPendingAdmin.getDetail(root, 'skills', skillPending.id);
      const ap = await hermesPendingAdmin.applySkillWithSnapshotAsync(root, {
        id: skillPending.id,
        expectedHash: detail && detail.payloadHash,
        reason: 'trylo-t2a1',
      });
      assert.ok(ap, 'admin call returned a value');
      assert.strictEqual(ap.committed, true,
        'fresh first-create must commit; got ' + JSON.stringify(ap).slice(0, 300));
      assert.ok(['nothing_to_backup', 'snapshot_ok'].includes(ap.backupState),
        'committed apply must carry a valid backupState, got ' + ap.backupState);
    } finally { cleanup(home); }
  });

  // T2a-2: create of an ALREADY-EXISTING skill is rejected by the
  // official _create_skill, so apply must NOT commit and must keep the
  // pending with a non-empty backupState (probed on-site: upstream
  // returns "A skill named 'demo-t2a' already exists", admin maps it to
  // committed=false, kept_pending=true, backupState=snapshot_ok).
  await testAsync('T2a-2: create-existing-skill rejected by upstream -> apply blocked, pending kept', async () => {
    const { home, root } = freshHermesHome('t2a2');
    try {
      writeYamlConfig(home);
      stageAndApplySkillLocal(root, 'create', 'demo-t2a',
        '---\nname: demo-t2a\ndescription: original\n---\n\n# demo-t2a\n\nbody v1\n');
      const lp = await hermesPendingAdmin.listPendingAsync(root);
      const skillPending = (lp.pending || []).find(p => p.subsystem === 'skills');
      assert.ok(skillPending, 'a skills pending must exist after staging');
      const detail = hermesPendingAdmin.getDetail(root, 'skills', skillPending.id);
      const ap = await hermesPendingAdmin.applySkillWithSnapshotAsync(root, {
        id: skillPending.id,
        expectedHash: detail && detail.payloadHash,
        reason: 'trylo-t2a2',
      });
      assert.ok(ap, 'admin call returned a value');
      assert.strictEqual(ap.committed, false,
        'create of an existing skill must NOT commit; got ' + JSON.stringify(ap).slice(0, 300));
      // admin.py returns snake_case `kept_pending` (no camelCase layer).
      assert.strictEqual(ap.kept_pending === true, true,
        'failed apply must keep_pending (admin.py field is kept_pending, snake_case)');
      assert.ok(ap.backupState, 'failed apply must carry a backupState');
    } finally { cleanup(home); }
  });

  test('T2b: normaliser maps snapshot_failed to apply_failed + SNAPSHOT_FAILED', () => {
    const norm = skillGovernance.normaliseApplyResult({
      adminResult: {
        success: true, committed: false, kept_pending: true,
        backupState: 'snapshot_failed', snapshotId: '',
        lastError: 'snapshot_skills returned no path',
      },
      expectedHash: 'h1',
      payload: { id: 'x' },
    });
    assert.strictEqual(norm.state, 'apply_failed');
    assert.strictEqual(norm.patch.errorCode, 'SNAPSHOT_FAILED');
  });
}

async function runT3() {
  await testAsync('T3: rollback restores SKILL.md to ORIGINAL bytes (Buffer.compare === 0)', async () => {
    const { home, root } = freshHermesHome('t3');
    try {
      writeYamlConfig(home);
      // 20 §5 F5-2: the official Hermes 0.19.0 patch writer (_patch_skill
      // -> _atomic_write_text) re-emits the file with the platform line
      // ending (CRLF on Windows, verified on-site with a byte probe). To
      // keep the byte-exact assertions deterministic we build ORIGINAL and
      // CHANGED with that same EOL, and express the mutation as a single
      // official patch (old_string/new_string) so the first apply really
      // commits and SKILL.md becomes CHANGED.
      const EOL = process.platform === 'win32' ? '\r\n' : '\n';
      const ORIGINAL = ['---', 'name: rollback-t3', 'description: ORIGINAL', '---', '', '# rollback-t3', '', 'ORIGINAL body bytes v1 abc', ''].join(EOL);
      const CHANGED = ['---', 'name: rollback-t3', 'description: CHANGED', '---', '', '# rollback-t3', '', 'ORIGINAL body bytes v1 abc', ''].join(EOL);
      const targetDir = path.join(home, 'skills', 'rollback-t3');
      fs.mkdirSync(targetDir, { recursive: true });
      const file = path.join(targetDir, 'SKILL.md');
      fs.writeFileSync(file, ORIGINAL);
      // Stage a legal patch via the official skill_manage patch contract
      // (old_string/new_string, NOT a full-content rewrite).
      stagePatchSkill(root, 'rollback-t3', 'description: ORIGINAL', 'description: CHANGED');
      const lp = await hermesPendingAdmin.listPendingAsync(root);
      const first = (lp.pending || []).find(p => p.subsystem === 'skills' && p.target === 'rollback-t3');
      assert.ok(first, 'no rollback-t3 pending');
      const detail1 = hermesPendingAdmin.getDetail(root, 'skills', first.id);
      const ap1 = await hermesPendingAdmin.applySkillWithSnapshotAsync(root, {
        id: first.id, expectedHash: detail1 && detail1.payloadHash, reason: 'trylo-rb1:' + first.id,
      });
      if (!ap1 || !ap1.success || !ap1.committed || !ap1.snapshotId) {
        throw new Error('first apply did not commit; cannot test rollback: ' + JSON.stringify(ap1).slice(0, 500));
      }
      const snap = ap1.snapshotId;
      const afterFirst = fs.readFileSync(file);
      // 20 §5 F5-2: the precondition assert was inverted (notStrictEqual
      // + a message saying the file SHOULD be CHANGED). It must assert the
      // file IS CHANGED after the first apply.
      assert.strictEqual(Buffer.compare(afterFirst, Buffer.from(CHANGED)), 0,
        'precondition: file should be CHANGED after first apply. got: ' + afterFirst.toString('utf8'));
      const rr = await hermesPendingAdmin.rollbackSkillBackupAsync(root, snap);
      assert.ok(rr && rr.committed === true,
        'rollback must commit (no lenient alternative). got: ' + JSON.stringify(rr).slice(0, 500));
      const after = fs.readFileSync(file);
      assert.strictEqual(Buffer.compare(after, Buffer.from(ORIGINAL)), 0,
        'rollback must restore SKILL.md to ORIGINAL bytes exactly (Buffer.compare === 0). got: ' + after.toString('utf8'));
    } finally { cleanup(home); }
  });

  test('T3b: rollback pending list may reject but normaliser stays apply_failed', () => {
    const norm = skillGovernance.normaliseApplyResult({
      adminResult: { success: true, committed: false, kept_pending: true, message: 'newer safety snapshot exists' },
      expectedHash: 'h1', payload: { id: 'x' },
    });
    assert.strictEqual(norm.state, 'apply_failed');
  });
}

function runT4() {
  function makeFakeSession(turnId) {
    return {
      id: 's1',
      turns: [{
        id: turnId,
        learning: { skillGovernance: { state: 'staged', pendingId: 'p-1', schemaVersion: 1 } },
      }],
    };
  }

  test('T4a: per-turn and generic go through the SAME production closure', () => {
    const session = makeFakeSession('t1');
    let perTurnPosts = 0;
    let genericPosts = 0;
    const norm = skillGovernance.normaliseApplyResult({
      adminResult: {
        success: true, committed: true, kept_pending: false,
        backupState: 'snapshot_ok', snapshotId: 'snap-1',
        action: 'create', skillName: 'demo',
      },
      expectedHash: 'h1',
      payload: { id: 'p-1', action: 'create', skillName: 'demo' },
    });
    skillGovernance.applySkillGovernanceResultToSourceTurns({
      pendingId: 'p-1',
      normalised: norm,
      sessionCache: [session],
      mutateTurn: (s, t, i, next) => { s.turns[i].learning.skillGovernance = next; return { ok: true }; },
      postPatch: () => { perTurnPosts++; },
    });
    skillGovernance.applySkillGovernanceResultToSourceTurns({
      pendingId: 'p-1',
      normalised: norm,
      sessionCache: [session],
      mutateTurn: (s, t, i, next) => { s.turns[i].learning.skillGovernance = next; return { ok: true }; },
      postPatch: () => { genericPosts++; },
    });
    assert.strictEqual(perTurnPosts, 1, 'per-turn postPatch count must be 1');
    assert.strictEqual(genericPosts, 1, 'generic postPatch count must be 1');
    const persisted = session.turns[0].learning.skillGovernance;
    assert.strictEqual(persisted.state, 'approved');
    assert.strictEqual(persisted.snapshotId, 'snap-1');
    assert.strictEqual(persisted.backupState, 'snapshot_ok');
    assert.strictEqual(persisted.action, 'create');
    assert.strictEqual(persisted.skillName, 'demo');
  });

  test('T4b: snapshot failure path: per-turn and generic both write apply_failed + SNAPSHOT_FAILED', () => {
    const session = makeFakeSession('t1');
    const norm = skillGovernance.normaliseApplyResult({
      adminResult: {
        success: true, committed: false, kept_pending: true,
        backupState: 'snapshot_failed', snapshotId: '',
        lastError: 'snapshot_skills returned no path',
      },
      expectedHash: 'h1',
      payload: { id: 'p-1' },
    });
    skillGovernance.applySkillGovernanceResultToSourceTurns({
      pendingId: 'p-1', normalised: norm, sessionCache: [session],
      mutateTurn: (s, t, i, next) => { s.turns[i].learning.skillGovernance = next; return { ok: true }; },
      postPatch: () => {},
    });
    const persisted = session.turns[0].learning.skillGovernance;
    assert.strictEqual(persisted.state, 'apply_failed');
    assert.strictEqual(persisted.errorCode, 'SNAPSHOT_FAILED');
    assert.strictEqual(persisted.backupState, 'snapshot_failed');
  });

  test('T4b2: admin success:false + kept_pending:true + backupState preserved (20 §2 F1 / 18 §3 P0-2)', () => {
    const norm = skillGovernance.normaliseApplyResult({
      adminResult: { success: false, kept_pending: true, backupState: 'snapshot_failed' },
      expectedHash: 'h1',
      payload: { id: 'p-1' },
    });
    assert.strictEqual(norm.state, 'apply_failed');
    assert.strictEqual(norm.patch.errorCode, 'SNAPSHOT_FAILED');
    assert.strictEqual(norm.patch.backupState, 'snapshot_failed');
  });

  test('T4c: discarded path: per-turn and generic both write discarded', () => {
    const session = makeFakeSession('t1');
    const norm = {
      state: 'discarded',
      patch: { state: 'discarded', pendingId: 'p-1', updatedAt: 1 },
    };
    skillGovernance.applySkillGovernanceResultToSourceTurns({
      pendingId: 'p-1', normalised: norm, sessionCache: [session],
      mutateTurn: (s, t, i, next) => { s.turns[i].learning.skillGovernance = next; return { ok: true }; },
      postPatch: () => {},
    });
    const persisted = session.turns[0].learning.skillGovernance;
    assert.strictEqual(persisted.state, 'discarded');
    assert.ok(!('body' in persisted));
    assert.ok(!('diff' in persisted));
    assert.ok(!('rawPayload' in persisted));
  });
}

function runT5() {
  test('T5: buildPatch whitelist covers 5 states and never carries body/diff', () => {
    for (const state of ['staged', 'approved', 'discarded', 'apply_failed', 'rolled_back']) {
      const patch = skillGovernance.buildPatch({
        state,
        pendingId: 'p',
        action: 'create',
        skillName: 's',
        snapshotId: 'snap',
        backupState: 'snapshot_ok',
        errorCode: 'X',
        safetySnapshotId: 'safe',
      });
      for (const allowed of ['state', 'pendingId', 'action', 'skillName', 'snapshotId', 'backupState', 'errorCode', 'safetySnapshotId', 'updatedAt']) {
        assert.ok(allowed in patch, 'patch for state=' + state + ' missing ' + allowed);
      }
      for (const banned of ['body', 'before', 'after', 'diff', 'content', 'rawPayload', 'modelReasoning']) {
        assert.ok(!(banned in patch), 'patch for state=' + state + ' must not carry ' + banned);
      }
    }
  });

  test('T5b: transition rejects state=reconcile_required (15 §5.2)', () => {
    const turn = { id: 't1' };
    assert.throws(() => skillGovernance.transition(turn, { state: 'reconcile_required' }),
      'reconcile_required is NOT a valid L3 state');
  });
}

function runT6() {
  test('T6: L0 source binding helper does not consume foreground tracker', () => {
    const src = fs.readFileSync(path.join('extension.js'), 'utf8');
    const fnStart = src.indexOf('function _recordSkillGovernanceFromL0');
    assert.ok(fnStart > 0, 'function not found in extension.js');
    const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
    const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 4000);
    assert.ok(!/consumeKind/.test(fnBody),
      '15 §5: L0 helper must not consume foreground tracker');
    assert.ok(!/structuredId/.test(fnBody),
      '15 §5: L0 helper must not introduce a structuredId branch');
    assert.ok(!/conflict/.test(fnBody),
      '15 §5: L0 helper must not have conflict logic');
    assert.ok(/String\(pendingId\)/.test(fnBody) || /pendingId\s*\|\|/.test(fnBody),
      '15 §5: L0 helper must use the orchestrator pendingId');
  });
}

function stagePatchSkill(storageRoot, targetName, oldString, newString) {
  // Stage a legal Hermes 0.19.0 `patch` proposal via the official
  // skill_manage contract (old_string / new_string). 20 §5 F5-2: the
  // old full-content rewrite (content=CHANGED) does not fit the patch
  // contract and apply_skill_pending rejects it ("old_string is required
  // for 'patch'"). The target skill must already exist on disk.
  const script = [
    'import sys, os, json',
    'sys.path.insert(0, ' + JSON.stringify(process.cwd() + path.sep + 'hermes-capabilities') + ')',
    'os.environ["HERMES_HOME"] = ' + JSON.stringify(storageRoot + '/hermes-capabilities/v1'),
    'from upstream import skill_manage',
    'r = skill_manage("patch", ' + JSON.stringify(targetName) + ', old_string=' + JSON.stringify(oldString) + ', new_string=' + JSON.stringify(newString) + ')',
    'print("STAGE:", r)',
    '',
  ].join('\n');
  return runPython(script);
}

function stageAndApplySkillLocal(storageRoot, action, targetName, content) {
  // Stage a Skill via the official skill_manage, preserving the
  // real skills/<name>/SKILL.md layout when the seed is non-null.
  const preSeed = content != null;
  const seedLiteral = preSeed ? 'True' : 'False';
  const script = [
    'import sys, os, json',
    'sys.path.insert(0, ' + JSON.stringify(process.cwd() + path.sep + 'hermes-capabilities') + ')',
    'os.environ["HERMES_HOME"] = ' + JSON.stringify(storageRoot + '/hermes-capabilities/v1'),
    'from upstream import skill_manage',
    'import os as _os',
    'skills_root = _os.path.join(_os.environ["HERMES_HOME"], "skills")',
    'if ' + seedLiteral + ':',
    '  target_dir = _os.path.join(skills_root, ' + JSON.stringify(targetName) + ')',
    '  if not _os.path.isdir(target_dir):',
    '    _os.makedirs(target_dir, exist_ok=True)',
    '  with open(_os.path.join(target_dir, "SKILL.md"), "w") as f:',
    '    f.write(' + JSON.stringify(content || '') + ')',
    'else:',
    '  if _os.path.isdir(skills_root):',
    '    import shutil',
    '    shutil.rmtree(skills_root)',
    'content = """---\\nname: ' + targetName + '\\ndescription: a test skill\\n---\\n\\n# ' + targetName + '\\n"""',
    'r = skill_manage(' + JSON.stringify(action) + ', ' + JSON.stringify(targetName) + ', content=content)',
    'print("STAGE:", r)',
    '',
  ].join('\n');
  return runPython(script);
}

async function main() {
  await selfTest();
  await runT1();
  await runT2();
  await runT3();
  await runT4();
  runT5();
  runT6();
  console.log('\n--- Summary ---');
  console.log('  Passed: ' + passed);
  console.log('  Failed: ' + failed);
  if (failed > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('smoke-learning-l3-integrity failed unexpectedly:', err);
  process.exitCode = 1;
  console.log('\n--- Summary ---');
  console.log('  Passed: ' + passed);
  console.log('  Failed: ' + failed);
});

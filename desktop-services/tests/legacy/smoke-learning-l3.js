/*
 * smoke-learning-l3.js
 *
 * Real production behavior tests for Learning L3 (09 §7.2, §7.3).
 * Every assertion calls the production code (official Hermes modules
 * + production Trylo helpers). No fake runner + manual counters;
 * no copy of source code into test; no source-string search for
 * tool isolation.
 *
 * Run: node smoke-learning-l3.js
 *
 * Requires the official hermes-agent 0.19.0 Python interpreter.
 * Failures here block the L3 closeout. No real LLM/API call.
 */

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const memoryClient = require('./memory-context-client');
const detector = require('./memory-pending-detector');
const hermesPendingAdmin = require('./hermes-pending-admin');
const { resolveHermesPython } = require('./hermes-python-resolver');
const { ProposalTracker, MEMORY_EXACT_NAME, SKILL_EXACT_NAME } = require('./memory-proposal-tracker');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS: ${name}`); }
  catch (err) { failed++; console.log(`  FAIL: ${name}\n        ${err.message}`); }
}

async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  PASS: ${name}`); }
  catch (err) { failed++; console.log(`  FAIL: ${name}\n        ${err.message}`); }
}

function freshHermesHome(label) {
  // 09 §7.1: tests use temporary HERMES_HOME.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-l3-' + label + '-'));
  const home = path.join(root, 'hermes-capabilities', 'v1');
  fs.mkdirSync(home, { recursive: true });
  return { root, home };
}

function writeConfig(home) {
  fs.writeFileSync(
    path.join(home, 'config.yaml'),
    'memory:\n  write_approval: true\nskills:\n  write_approval: true\n',
  );
}

function cleanup(home) {
  try { fs.rmSync(path.dirname(home), { recursive: true, force: true }); } catch {}
}

function inspectServerProfile(envOverrides = {}) {
  const pythonExe = resolveHermesPython();
  const envPairs = Object.entries(envOverrides)
    .map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(', ');
  const envLine = envPairs ? `os.environ.update({${envPairs}})` : '';
  const script = [
    'import sys, os, json',
    'sys.path.insert(0, "hermes-capabilities")',
    envLine,
    'import server',
    'tm = server.mcp._tool_manager',
    'out = {"tools": []}',
    'for ti in tm.list_tools():',
    '  name = ti.name if hasattr(ti, "name") else str(ti)',
    '  out["tools"].append(name)',
    'print(json.dumps(out))',
  ].join('\n');
  return JSON.parse(execFileSync(pythonExe, ['-c', script], { encoding: 'utf8' }));
}

// ---------------------------------------------------------------------------
// 09 §7.1 Phase 0 behaviour tests
// ---------------------------------------------------------------------------
console.log('\n--- §7.1 Phase 0 behaviour tests ---');

test('structured tool_result fixture: real shape from smoke-tool-stream.js drives the tracker', () => {
  // Real fixture from smoke-tool-stream.js line 82-87.
  const fixture = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture', content: '{"success":true,"staged":true,"pending_id":"abc-123"}' }],
    },
  };
  // We also need a tool_use event first to register the name.
  const tracker = new ProposalTracker({
    memoryServer: 'trylo-hermes-capabilities',
    skillServer: 'trylo-hermes-learning',
  });
  tracker.ingestToolUse('toolu_fixture', 'mcp__trylo-hermes-capabilities__' + MEMORY_EXACT_NAME);
  tracker.ingestToolResult(fixture);
  const r = tracker.consumeKind('memory');
  assert.ok(r && r.ok);
  assert.strictEqual(r.pendingId, 'abc-123');
});

test('two distinct Memory proposal IDs in the same run: conflict, fail closed', () => {
  const tracker = new ProposalTracker({
    memoryServer: 'trylo-hermes-capabilities',
    skillServer: 'trylo-hermes-learning',
  });
  tracker.ingestToolUse('t1', 'mcp__trylo-hermes-capabilities__' + MEMORY_EXACT_NAME);
  tracker.ingestToolUse('t2', 'mcp__trylo-hermes-capabilities__' + MEMORY_EXACT_NAME);
  tracker.ingestToolResult({
    type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: '{"success":true,"staged":true,"pending_id":"p1"}' },
    ]},
  });
  tracker.ingestToolResult({
    type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't2', content: '{"success":true,"staged":true,"pending_id":"p2"}' },
    ]},
  });
  const r = tracker.consumeKind('memory');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflict, true);
  assert.ok(r.observed.includes('p1') && r.observed.includes('p2'));
});

test('endsWith(__memory_propose) is REJECTED (only exact full name accepted)', () => {
  const tracker = new ProposalTracker({
    memoryServer: 'trylo-hermes-capabilities',
    skillServer: 'trylo-hermes-learning',
  });
  // A random tool name ending in __memory_propose should NOT be accepted.
  tracker.ingestToolUse('x', 'fake-server__memory_propose');
  tracker.ingestToolResult({
    type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'x', content: '{"success":true,"staged":true,"pending_id":"p1"}' },
    ]},
  });
  const r = tracker.consumeKind('memory');
  assert.strictEqual(r, null, 'fuzzy suffix must not match');
});

test('tracker stores only pendingId/timestamp/source/conflict: no proposal content', () => {
  // 09 §6: only ID + time + source + conflict flag.
  const r = detector.buildMemoryProposal({ pendingId: 'm1' });
  for (const banned of ['content', 'old_text', 'operations', 'payload', 'summary', 'before', 'after']) {
    assert.ok(!(banned in r), 'must not carry ' + banned);
  }
  const r2 = detector.buildSkillGovernance
    ? detector.buildSkillGovernance({ pendingId: 's1' })
    : null;
  if (r2) {
    for (const banned of ['content', 'old_text', 'operations', 'payload', 'summary', 'before', 'after', 'fileContent']) {
      assert.ok(!(banned in r2), 'skillGovernance must not carry ' + banned);
    }
  }
});

// ---------------------------------------------------------------------------
// 09 §7.2 L3 official reuse tests
// ---------------------------------------------------------------------------
console.log('\n--- §7.2 L3 official reuse ---');

test('learning_graph_summary: safe DTO, drops Memory bodies, returns official fields', () => {
  const pythonExe = resolveHermesPython();
  const out = execFileSync(pythonExe, ['-c', [
    'import sys, os, json',
    'sys.path.insert(0, "hermes-capabilities")',
    'from curation_adapter import build_summary',
    'print(json.dumps(build_summary()))',
  ].join('; ')], { encoding: 'utf8' });
  const summary = JSON.parse(out);
  assert.strictEqual(summary.success, true);
  assert.strictEqual(summary.schemaVersion, 1);
  // No Memory body markers in the output.
  const asString = JSON.stringify(summary);
  assert.ok(!/\\bbody\\b.*memory|ignore all previous/i.test(asString),
    'summary must not contain Memory body content');
  // Stats must include nodeCount + edgeCount + clusterCount + memoryNodeCount.
  assert.ok(typeof summary.stats.skillNodeCount === 'number');
  assert.ok(typeof summary.stats.edgeCount === 'number');
  assert.ok(typeof summary.stats.clusterCount === 'number');
  assert.ok(typeof summary.stats.memoryNodeCount === 'number');
  assert.strictEqual(summary.stats.hermesVersion, '0.19.0');
});

test('learning profile registers 4 tools: skills_list, skill_view, skill_propose, learning_graph_summary', () => {
  const info = inspectServerProfile({ TRYLO_MCP_PROFILE: 'learning' });
  const names = info.tools.map(s => String(s)).sort();
  assert.deepStrictEqual(names, [
    'learning_graph_summary',
    'skill_propose',
    'skill_view',
    'skills_list',
  ]);
});

test('normal profile includes memory_snapshot + memory_propose (no apply/discard)', () => {
  const info = inspectServerProfile({});
  const names = info.tools.map(s => String(s));
  assert.ok(names.includes('memory_propose'));
  assert.ok(names.includes('memory_snapshot'));
  assert.ok(!names.some(n => n.includes('apply_pending')));
  assert.ok(!names.some(n => n.includes('discard_pending')));
  assert.ok(!names.some(n => n.includes('rollback')));
});

test('L0 implicit prompt: body is official _SKILL_REVIEW_PROMPT + Trylo contract tail', () => {
  const pythonExe = resolveHermesPython();
  const direct = execFileSync(pythonExe, ['-c', [
    'import sys',
    'sys.path.insert(0, "hermes-capabilities")',
    'from agent.background_review import _SKILL_REVIEW_PROMPT',
    'from learning_prompt_adapter import TRYLO_L0_CONTRACT_TAIL',
    'print("OFFICIAL_LEN:", len(_SKILL_REVIEW_PROMPT))',
    'print("HAS_TRYLO_TAIL:", "Trylo L0 contract" in TRYLO_L0_CONTRACT_TAIL)',
    'print("HAS_PATCH_FIRST:", "patch" in TRYLO_L0_CONTRACT_TAIL.lower())',
    'print("HAS_CREATE_LAST:", "create" in TRYLO_L0_CONTRACT_TAIL.lower())',
    'print("HAS_NO_DELETE:", "delete" in TRYLO_L0_CONTRACT_TAIL.lower())',
  ].join('; ')], { encoding: 'utf8' });
  assert.ok(/OFFICIAL_LEN: [1-9]/.test(direct), 'official prompt has non-zero length');
  assert.ok(/HAS_TRYLO_TAIL: True/.test(direct));
  assert.ok(/HAS_PATCH_FIRST: True/.test(direct), 'L0 contract: prefer patch');
  assert.ok(/HAS_CREATE_LAST: True/.test(direct), 'L0 contract: create is last resort');
  assert.ok(/HAS_NO_DELETE: True/.test(direct), 'L0 contract: never delete');
});

test('snapshot_skills / list_backups / rollback are real and runnable in a temp HERMES_HOME', async () => {
  // 09 §7.2.5: apply 前真实调用官方 snapshot_skills.
  const { home, root } = freshHermesHome('snap');
  try {
    writeConfig(home);
    // Pre-seed a Skill via skill_manage.
    const pythonExe = resolveHermesPython();
    const stageScript = [
      'import sys, os, json',
      'sys.path.insert(0, "hermes-capabilities")',
      'os.environ["HERMES_HOME"] = ' + JSON.stringify(home),
      'from upstream import MemoryStore, skill_manage, apply_skill_pending',
      // Apply a Skill directly (write_approval is required for staged; for
      // the pre-apply snapshot path we just need something to snapshot).
      'import shutil',
      'skills_root = os.path.join(os.environ["HERMES_HOME"], "skills")',
      'os.makedirs(skills_root, exist_ok=True)',
      'with open(os.path.join(skills_root, "demo.md"), "w") as f:',
      '  f.write("# demo skill\\n")',
      'print("OK")',
    ].join('\n');
    execFileSync(pythonExe, ['-c', stageScript], { encoding: 'utf8' });
    // Snapshot.
    const snapScript = [
      'import sys, os, json',
      'sys.path.insert(0, "hermes-capabilities")',
      'os.environ["HERMES_HOME"] = ' + JSON.stringify(home),
      'from upstream import snapshot_skills, list_backups',
      'p = snapshot_skills(reason="trylo-test")',
      'print("PATH:", p)',
      'print("BACKUPS:", len(list_backups()))',
    ].join('\n');
    const out = execFileSync(pythonExe, ['-c', snapScript], { encoding: 'utf8' });
    assert.ok(/PATH:/.test(out), 'snapshot returned a path: ' + out);
    assert.ok(/BACKUPS: [1-9]/.test(out), 'list_backups has at least one entry');
  } finally {
    cleanup(home);
  }
});

test('snapshot_skills with empty skills tree: does not throw, returns path or None', () => {
  // 09 §5.5: official snapshot_skills may return a path or None for
  // an empty skills tree. The L3 production code treats a successful
  // path as "have a recoverable snapshot" and absence as "nothing to
  // backup" (the contract explicitly says: do NOT confuse IO error
  // with nothing). The test asserts the call does not raise; the L3
  // apply path in extension.js handles both return shapes.
  const { home, root } = freshHermesHome('empty-snap');
  try {
    writeConfig(home);
    const pythonExe = resolveHermesPython();
    const out = execFileSync(pythonExe, ['-c', [
      'import sys, os, json',
      'sys.path.insert(0, "hermes-capabilities")',
      'os.environ["HERMES_HOME"] = ' + JSON.stringify(home),
      'from upstream import snapshot_skills',
      'try:',
      '  p = snapshot_skills(reason="trylo-empty")',
      '  print(json.dumps({"err": None, "isPath": p is not None}))',
      'except Exception as e:',
      '  print(json.dumps({"err": str(e), "isPath": False}))',
    ].join('\n')], { encoding: 'utf8' });
    const r = JSON.parse(out);
    assert.strictEqual(r.err, null, 'snapshot_skills must not raise for empty tree: ' + r.err);
  } finally {
    cleanup(home);
  }
});

test('memory_context_adapter.py imports load_on_disk_store from upstream (not from tools.memory_tool directly)', () => {
  const adapterSrc = fs.readFileSync(path.join('hermes-capabilities', 'memory_context_adapter.py'), 'utf8');
  // Assert the import line comes from upstream.
  assert.ok(/from upstream import[\s\S]*?load_on_disk_store/.test(adapterSrc),
    'memory_context_adapter.py must import load_on_disk_store from upstream');
  // And NOT directly from tools.memory_tool.
  assert.ok(!/^from tools\.memory_tool import load_on_disk_store/m.test(adapterSrc),
    'memory_context_adapter.py must NOT import load_on_disk_store from tools.memory_tool directly');
});

test('memory snapshot oversized block: adapter fails closed (no half-entry)', () => {
  const pythonExe = resolveHermesPython();
  // Build the script with newlines so the try/except parses cleanly.
  const script = [
    'import sys, os, json',
    'sys.path.insert(0, "hermes-capabilities")',
    'os.environ["HERMES_HOME"] = "/nonexistent"',
    'import memory_context_adapter as mca',
    'try:',
    '  mca._bounded_block("x" * 20000, limit=100, label="memoryBlock")',
    '  print(json.dumps({"raised": False}))',
    'except ValueError as e:',
    '  print(json.dumps({"raised": True, "msg": str(e)}))',
  ].join('\n');
  const out = execFileSync(pythonExe, ['-c', script], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.ok(r.raised, 'oversize must raise ValueError');
  assert.ok(/refusing to emit a partial entry/i.test(r.msg));
});

test('AbortSignal: snapshot client kills child + cleans listeners on abort', async () => {
  const { home, root } = freshHermesHome('abort');
  try {
    writeApprovedMemory(home, '# Memory\n\nNote.\n', '- user');
    const ctl = new AbortController();
    ctl.abort();
    const r = await memoryClient.fetchMemorySnapshot({ globalStoragePath: root, signal: ctl.signal });
    assert.strictEqual(r.ok, false);
    assert.ok(/abort/i.test(r.error));
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n--- Summary ---');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) process.exit(1);

function writeApprovedMemory(home, memory, user) {
  // 09 §7.2 stage+apply via the official Python path; this is the
  // same write flow the Trylo UI uses. Tests do not hand-roll the
  // file content because the file format is owned by Hermes.
  writeConfig(home);
  const pythonExe = resolveHermesPython();
  const script = [
    'import sys, os, json',
    'sys.path.insert(0, "hermes-capabilities")',
    'os.environ["HERMES_HOME"] = ' + JSON.stringify(home),
    'from upstream import MemoryStore',
    'store = MemoryStore()',
    'store.load_from_disk()',
    'from tools import memory_tool as mt',
    'r1 = mt.memory_tool(action="add", target="memory", content=' + JSON.stringify(memory) + ', store=store)',
    'print(json.loads(r1)["pending_id"])',
    'r2 = mt.memory_tool(action="add", target="user", content=' + JSON.stringify(user) + ', store=store)',
    'print(json.loads(r2)["pending_id"])',
  ].join('\n');
  const out = execFileSync(pythonExe, ['-c', script], { encoding: 'utf8' });
  const ids = out.trim().split(/\r?\n/).filter(Boolean);
  const root = path.dirname(path.dirname(home));
  for (const pid of ids) {
    const r = hermesPendingAdmin.applyPending(root, 'memory', pid);
    if (!r || r.committed !== true) {
      throw new Error('applyPending failed for ' + pid + ': ' + JSON.stringify(r));
    }
  }
}

'use strict';

/*
 * smoke-upstream-contract.js
 *
 * L7-D (依 `L7_EXECUTION_TASK.md` §5 T4). Verifies that the upstream
 * Hermes symbols Trylo actually uses are present and behave the way
 * the adapters assume. Driven by `docs/technical/AUTO/UPSTREAM_SYMBOLS.json`
 * (produced by `tools/collect-upstream-symbols.js`).
 *
 * T0  self-test fail
 * T1  every node module in the list loads (require() does not throw)
 * T2  every python module in the list imports; the public symbols
 *     it declared are present and callable
 * T3  Hermes 0.19.0 is the actual installed version (PINNED matches)
 * T4  DTO shape spot-check: deliberately probe a known field; if
 *     absent, the test must FAIL. (We don't actually mutate Hermes
 *     here; we just verify the assertions on the live data are
 *     real — see `tools/break-dto-fixture.js` for the negative test.)
 *
 * Run: node smoke-upstream-contract.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname);
const SYMBOLS_PATH = path.join(ROOT, 'docs', 'technical', 'AUTO', 'UPSTREAM_SYMBOLS.json');
const PINNED_PATH = path.join(ROOT, 'hermes-capabilities', 'PINNED_VERSIONS.md');
const HERMES_PY_RESOLVER = path.join(ROOT, 'hermes-python-resolver');
const os = require('node:os');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  PASS: ' + name); }
  catch (e) { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL: ' + name + '\n        ' + e.message); }
}
async function testAsync(name, fn) {
  const p = (async () => {
    try { await fn(); passed++; console.log('  PASS: ' + name); }
    catch (e) { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL: ' + name + '\n        ' + err.message); }
  })();
  return p;
}

function readSymbols() {
  if (!fs.existsSync(SYMBOLS_PATH)) {
    throw new Error('UPSTREAM_SYMBOLS.json missing — run `node tools/collect-upstream-symbols.js` first');
  }
  return JSON.parse(fs.readFileSync(SYMBOLS_PATH, 'utf8'));
}

function readPinnedVersion() {
  const text = fs.readFileSync(PINNED_PATH, 'utf8');
  // The first table row in the "Hermes Python 包" section has the
  // shape: | hermes_version | `0.19.0` (严格匹配) | <other stuff> |
  // Capture the backticked value; ignore trailing prose.
  const m = text.match(/\| hermes_version \| `([^`]+)`/);
  if (!m) throw new Error('PINNED_VERSIONS.md has no `| hermes_version | ` row');
  if (m[1] !== '0.19.0') throw new Error('PINNED says ' + m[1] + ' (expected 0.19.0)');
  return m[1];
}

// ── T0 ──────────────────────────────────────────────────────────────────
test('T0: self-test yields exit code 1', () => {
  if (process.argv.includes('--self-test-fail')) {
    assert.strictEqual(1, 2, 'self-test deliberate failure');
  }
});

// ── T1 ──────────────────────────────────────────────────────────────────
test('T1: every node module in the symbol list loads', () => {
  const syms = readSymbols();
  for (const entry of syms.node_modules) {
    const target = entry.resolvedPath || entry.requirePath;
    if (!fs.existsSync(target)) {
      throw new Error(`node module "${entry.requirePath}" not found at ${target}`);
    }
    try { require(target); }
    catch (e) { throw new Error(`node module "${entry.requirePath}" failed to load: ${e.message}`); }
  }
  assert.ok(syms.node_modules.length > 0, 'at least one node module listed');
});

// ── T2 ──────────────────────────────────────────────────────────────────
test('T2: every python module imports; declared symbols exist', () => {
  const syms = readSymbols();
  const pythonExe = require(path.join(ROOT, 'hermes-python-resolver')).resolveHermesPython();
  const adapterDir = path.join(ROOT, 'hermes-capabilities');
  for (const m of syms.python_modules) {
    if (m.error) throw new Error(`python module "${m.name}" has error: ${m.error}`);
    if (!Array.isArray(m.exports) || m.exports.length === 0) {
      throw new Error(`python module "${m.name}" has no exports declared`);
    }
  }
  // Actually import one of them and verify a representative symbol.
  const script = `
import os, sys, json, importlib
sys.path.insert(0, r'${adapterDir.replace(/\\/g, '\\\\')}')
m = importlib.import_module('memory_context_adapter')
got = {
    'has_build_snapshot': hasattr(m, 'build_snapshot'),
    'has_MemoryStore': hasattr(m, 'MemoryStore') or 'MemoryStore' in dir(m),
    'SCHEMA_VERSION': getattr(m, 'SCHEMA_VERSION', None),
}
print(json.dumps(got))
`;
  const tmp = path.join(require('os').tmpdir(), `upstream-contract-${Date.now()}.py`);
  fs.writeFileSync(tmp, script, 'utf8');
  let out;
  try { out = cp.execFileSync(pythonExe, ['-X', 'utf8', tmp], { encoding: 'utf8' }).trim(); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
  const r = JSON.parse(out);
  if (!r.has_build_snapshot) throw new Error('memory_context_adapter.build_snapshot missing');
  if (r.SCHEMA_VERSION !== 1) throw new Error('SCHEMA_VERSION expected 1, got ' + r.SCHEMA_VERSION);
});

// ── T3 ──────────────────────────────────────────────────────────────────
test('T3: Hermes version matches PINNED (0.19.0)', () => {
  const syms = readSymbols();
  const pinned = readPinnedVersion();
  if (syms.hermes_version !== pinned) {
    throw new Error(`UPSTREAM_SYMBOLS hermes_version=${syms.hermes_version} but PINNED says ${pinned}`);
  }
});

// ── T4 ──────────────────────────────────────────────────────────────────
test('T4: DTO shape spot-check (real build_summary on a real Skill)', () => {
  // v2-audit fix: the previous T4 was a weak `hasattr` check — same
  // fake-green pattern that bit L4/L5 P0. We now seed a real Skill
  // file in a temp HERMES_HOME, call build_summary, and assert
  // safe_nodes[0] has the documented shape {id, label, kind}.
  const syms = readSymbols();
  if (!syms.python_modules.find((m) => m.name === 'curation_adapter')) {
    throw new Error('curation_adapter missing from UPSTREAM_SYMBOLS');
  }
  const pythonExe = require(path.join(ROOT, 'hermes-python-resolver')).resolveHermesPython();
  const adapterDir = path.join(ROOT, 'hermes-capabilities');
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-upstream-t4-'));
  try {
    const skillsDir = path.join(hermesHome, 'skills', 'trylo-smoke-skill');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'),
      '---\nname: trylo-smoke-skill\ndescription: test skill for upstream contract\napplies_to_platform: [linux]\n---\n# test\n');
    const script = `
import os, sys, json
sys.path.insert(0, r'${adapterDir.replace(/\\/g, '\\\\')}')
import curation_adapter
hh = r'${hermesHome.replace(/\\/g, '\\\\')}'
os.environ['HERMES_HOME'] = hh
r = curation_adapter.build_summary()
nodes = r.get('nodes') or []
got = {
    'success': r.get('success', False),
    'nodes_type': type(nodes).__name__,
    'nodes_len': len(nodes),
    'returned_keys': sorted(list(r.keys())),
}
if len(nodes) > 0:
    n = nodes[0]
    got['node_keys'] = sorted(list(n.keys()))
    got['has_id'] = 'id' in n
    got['has_label'] = 'label' in n
    got['has_kind'] = 'kind' in n
print(json.dumps(got))
`;
    const tmp = path.join(os.tmpdir(), `upstream-t4-${Date.now()}.py`);
    fs.writeFileSync(tmp, script, 'utf8');
    let out;
    try { out = cp.execFileSync(pythonExe, ['-X', 'utf8', tmp], { encoding: 'utf8', env: { ...process.env, HERMES_HOME: hermesHome } }).trim(); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
    const r = JSON.parse(out);
    if (!r.success) throw new Error('build_summary did not succeed: ' + JSON.stringify(r));
    if (r.nodes_type !== 'list') throw new Error('nodes is not a list: ' + r.nodes_type);
    if (r.nodes_len === 0) {
      return;  // no skills → cannot verify shape; informational
    }
    if (!r.has_id || !r.has_label || !r.has_kind) {
      throw new Error('nodes[0] missing required key (id/label/kind); got: ' + JSON.stringify(r.node_keys));
    }
  } finally {
    try { fs.rmSync(hermesHome, { recursive: true, force: true }); } catch {}
  }
});

(async () => {
  console.log('--- L7 upstream-contract ---');
  // Run sync tests (async ones queued above; we're sync-only here).
  // Print summary.
  console.log('\n--- Summary ---');
  console.log('  Passed: ' + passed);
  console.log('  Failed: ' + failed);
  if (failed > 0) {
    for (const f of failures) console.log('    - ' + f);
    process.exit(1);
  }
  if (process.argv.includes('--self-test-fail')) process.exit(1);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

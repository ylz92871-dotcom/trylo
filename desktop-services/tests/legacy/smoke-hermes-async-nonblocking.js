/*
 * smoke-hermes-async-nonblocking.js
 *
 * Verifies R3: session sync is async and never blocks the event loop.
 *  - mirrorSession returns a Promise (not spawnSync).
 *  - a short timer fires WHILE a debounced mirror is pending (no host freeze).
 *  - rapid calls for one session coalesce to the LATEST snapshot; all promises
 *    settle (no dangling handles).
 *  - shutdown settles bounded.
 *
 * Run: npm run smoke:hermes-async-nonblocking
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveHermesPython } = require('./hermes-python-resolver');
const hermesCapabilityManager = require('./hermes-capability-manager');
const hermesSessionSync = require('./hermes-session-sync');

const SEARCH_PY = String.raw`
import json, os
from tools.session_search_tool import session_search
from hermes_state import SessionDB
db = SessionDB()
try:
    r = json.loads(session_search(query=os.environ.get('Q',''), db=db))
    print(json.dumps({'count': r.get('count',0), 'ids': [x.get('session_id') for x in r.get('results', [])]}))
finally:
    db.close()
`;

function search(pythonExe, script, hermesHome, q) {
  const r = spawnSync(pythonExe, [script], {
    env: { ...process.env, HERMES_HOME: hermesHome, Q: q, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`search exited ${r.status}: ${(r.stderr || '').slice(0, 300)}`);
  return JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop());
}

function makeSession(id, prompt, result) {
  const base = Date.now();
  return {
    id, title: id, workspace: { id: 'w', name: 'n', path: 'D:/w' }, model: 'm',
    turns: [{ id: 't', prompt, resultText: result, startedAt: base }],
  };
}

async function main() {
  const pythonExe = resolveHermesPython();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-async-'));
  const hermesHome = hermesCapabilityManager.getHermesHome(storagePath);
  hermesCapabilityManager.ensureDataDir(storagePath);
  const searchScript = path.join(storagePath, '_search.py');
  fs.writeFileSync(searchScript, SEARCH_PY, 'utf8');

  try {
    // 1. mirrorSession returns a Promise.
    const p = hermesSessionSync.mirrorSession(makeSession('async-1', 'v1 prompt', 'v1 answer'), storagePath);
    assert.ok(p && typeof p.then === 'function', 'mirrorSession must return a Promise');

    // 2. Event loop not blocked: a 50ms timer must fire while the debounced
    //    mirror (>=300ms) is still pending.
    let timerFiredEarly = false;
    const timerP = new Promise(r => setTimeout(() => { timerFiredEarly = true; r(); }, 50));
    await Promise.race([timerP, p]);
    assert.ok(timerFiredEarly, '50ms timer must fire during pending mirror (no blocking)');
    await p;

    // 3. Debounce coalescing: rapid calls for one session -> latest wins; all settle.
    const a = hermesSessionSync.mirrorSession(makeSession('async-co', 'alphaPrompt', 'alphaAnswer'), storagePath);
    const b = hermesSessionSync.mirrorSession(makeSession('async-co', 'betaPrompt', 'betaAnswer'), storagePath);
    const c = hermesSessionSync.mirrorSession(makeSession('async-co', 'gammaPrompt', 'gammaAnswer'), storagePath);
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    assert.equal(ra, true, 'superseded alpha promise must settle');
    assert.equal(rb, true, 'superseded beta promise must settle');
    assert.equal(rc, true, 'latest gamma promise must settle');
    await new Promise(r => setTimeout(r, 900));  // let debounce + sync finish

    const g = search(pythonExe, searchScript, hermesHome, 'gammaPrompt');
    assert.ok(g.ids.includes('trylo_async-co'), `gamma (latest) must be mirrored: ${JSON.stringify(g)}`);
    const al = search(pythonExe, searchScript, hermesHome, 'alphaPrompt');
    assert.ok(!al.ids.includes('trylo_async-co'), `alpha (superseded) must NOT be mirrored: ${JSON.stringify(al)}`);
    process.stdout.write('debounce coalesced to latest snapshot; all promises settled\n');

    // 4. shutdown settles (bounded).
    await hermesSessionSync.shutdown();
    process.stdout.write('Hermes async nonblocking smoke test passed.\n');
  } finally {
    try { fs.rmSync(storagePath, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => { console.error(err && err.stack ? err.stack : err); process.exitCode = 1; });

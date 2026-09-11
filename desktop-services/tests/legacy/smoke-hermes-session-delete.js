/*
 * smoke-hermes-session-delete.js
 *
 * Verifies R4: rebuild delete-sync. A trylo-vscode session that no longer exists
 * in the Trylo JSON library is removed from the index (and unsearchable), while
 * sessions owned by other sources (gateway/subagent/...) are never touched.
 * Also re-verifies rebuild-from-JSON after deletion.
 *
 * Run: npm run smoke:hermes-session-delete
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
    print(json.dumps({'success': r.get('success'), 'count': r.get('count',0),
                      'ids': [x.get('session_id') for x in r.get('results', [])]}))
finally:
    db.close()
`;

// Seed a non-trylo session directly so we can prove delete-sync leaves it alone.
const SEED_PY = String.raw`
import json, os, time
from hermes_state import SessionDB
db = SessionDB()
try:
    sid = os.environ['SEED_ID']
    source = os.environ.get('SEED_SOURCE','gateway')
    db.ensure_session(sid, source=source, model='m')
    db.replace_messages(sid, [{'role':'user','content':'gateway fixture about storage quotas','timestamp':time.time()}])
    print('seeded', sid, source)
finally:
    db.close()
`;

function runPy(pythonExe, script, env) {
  const r = spawnSync(pythonExe, [script], { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`py exited ${r.status}: ${(r.stderr || '').slice(0, 400)}`);
  return r.stdout;
}

function makeSession(id, title, text) {
  const base = Date.now();
  return {
    id, title, workspace: { id: 'w', name: 'demo', path: 'D:/work/demo' },
    model: 'claude-fable-5',
    turns: [{ id: 't1', prompt: text, resultText: `answer about ${text}`, startedAt: base }],
  };
}

function main() {
  const pythonExe = resolveHermesPython();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-del-'));
  const hermesHome = hermesCapabilityManager.getHermesHome(storagePath);
  hermesCapabilityManager.ensureDataDir(storagePath);
  const searchScript = path.join(storagePath, '_search.py');
  fs.writeFileSync(searchScript, SEARCH_PY, 'utf8');
  const seedScript = path.join(storagePath, '_seed.py');
  fs.writeFileSync(seedScript, SEED_PY, 'utf8');

  function search(q) {
    const out = runPy(pythonExe, searchScript, { HERMES_HOME: hermesHome, Q: q, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
    const line = out.trim().split(/\r?\n/).pop();
    return JSON.parse(line);
  }

  const chain = Promise.resolve()
    .then(() => hermesSessionSync.mirrorSession(makeSession('del-alpha', 'Alpha 任务', 'alpha topic deployment'), storagePath))
    .then(() => {
      const r = search('alpha topic');
      assert.ok(r.count >= 1 && r.ids.includes('trylo_del-alpha'), `alpha should be found: ${JSON.stringify(r)}`);

      // Seed a non-trylo session (gateway source).
      runPy(pythonExe, seedScript, { HERMES_HOME: hermesHome, SEED_ID: 'gw-fixture', SEED_SOURCE: 'gateway', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
      const gw = search('gateway fixture');
      assert.ok(gw.count >= 1 && gw.ids.includes('gw-fixture'), `gateway should be found: ${JSON.stringify(gw)}`);

      // rebuild with an EMPTY Trylo library -> trylo session deleted, gateway kept.
      return hermesSessionSync.rebuildIndex([], storagePath);
    })
    .then(() => {
      const afterAlpha = search('alpha topic');
      assert.ok(!afterAlpha.ids.includes('trylo_del-alpha'),
        `deleted trylo session must not be found: ${JSON.stringify(afterAlpha)}`);
      const afterGw = search('gateway fixture');
      assert.ok(afterGw.ids.includes('gw-fixture'),
        `gateway session must survive trylo delete-sync: ${JSON.stringify(afterGw)}`);
      process.stdout.write('delete-sync removed trylo row, kept other source\n');

      // rebuild from Trylo JSON restores the trylo session.
      return hermesSessionSync.rebuildIndex([makeSession('del-alpha', 'Alpha 任务', 'alpha topic deployment')], storagePath);
    })
    .then(() => {
      const restored = search('alpha topic');
      assert.ok(restored.ids.includes('trylo_del-alpha'), `trylo session should be rebuilt: ${JSON.stringify(restored)}`);
      process.stdout.write('rebuild from Trylo JSON restored session\n');
      process.stdout.write('Hermes session-delete smoke test passed.\n');
    })
    .finally(() => {
      try { fs.rmSync(storagePath, { recursive: true, force: true }); } catch {}
    });
  return chain;
}

module.exports = { main };

if (require.main === module) {
  main().then(() => {}, err => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

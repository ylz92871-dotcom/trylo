/*
 * smoke-hermes-session-mirror.js
 *
 * Verifies Phase 3: Trylo session turns mirror into the Hermes SessionDB
 * search index, CJK content is retrievable via session_search, and the index
 * can be fully rebuilt from the Trylo session library after state.db is
 * deleted (Hermes fusion architecture section 11 Phase 3 acceptance).
 *
 * Everything runs in a throwaway globalStorage dir; user data is never touched.
 *
 * Run: npm run smoke:hermes-session-mirror
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveHermesPython } = require('./hermes-python-resolver');
const hermesSessionSync = require('./hermes-session-sync');
const { getHermesHome } = require('./hermes-capability-manager');

const SEARCH_PY = String.raw`
import json, os
from tools.session_search_tool import session_search
from hermes_state import SessionDB
db = SessionDB()
try:
    r = json.loads(session_search(query=os.environ.get('Q', ''), db=db))
    print(json.dumps({'success': r.get('success'), 'count': r.get('count', 0),
                      'ids': [x.get('session_id') for x in r.get('results', [])]}))
finally:
    db.close()
`;

function makeSession() {
  const base = Date.now();
  return {
    id: 'trylo_mirror_smoke',
    title: '中文会话镜像测试',
    workspace: { id: 'w', name: 'demo', path: 'D:/work/demo' },
    model: 'claude-fable-5',
    turns: [
      {
        id: 't1',
        prompt: '帮我总结一下密码学的核心概念',
        resultText: '密码学的核心包括对称加密、非对称加密和哈希函数。',
        startedAt: base,
        updatedAt: base,
      },
      {
        id: 't2',
        prompt: '什么是非对称加密？',
        resultText: '非对称加密使用公钥和私钥配对，例如 RSA 算法。',
        startedAt: base + 1000,
        updatedAt: base + 1000,
      },
    ],
  };
}

function runSearch(pythonExe, hermesHome, query) {
  const scriptPath = path.join(hermesHome, '_search.py');
  fs.writeFileSync(scriptPath, SEARCH_PY, 'utf8');
  const result = spawnSync(pythonExe, [scriptPath], {
    env: {
      ...process.env,
      HERMES_HOME: hermesHome,
      Q: query,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`search failed: ${(result.stderr || '').slice(0, 400)}`);
  }
  const lines = (result.stdout || '').split(/\r?\n/).filter(l => l.trim());
  return JSON.parse(lines[lines.length - 1]);
}

async function main() {
  const pythonExe = resolveHermesPython();
  process.stdout.write(`Hermes python: ${pythonExe}\n`);

  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mirror-'));
  const hermesHome = getHermesHome(storagePath);
  const session = makeSession();

  try {
    // 1. Mirror the session (R3: async, debounced 300ms, serialized).
    const mirrored = await hermesSessionSync.mirrorSession(session, storagePath);
    assert.equal(mirrored, true, 'mirrorSession should succeed');
    process.stdout.write('mirrored session\n');

    // 2. CJK search finds it.
    let res = runSearch(pythonExe, hermesHome, '密码学');
    assert.equal(res.success, true, 'search should succeed');
    assert.ok(res.count >= 1, `expected >=1 result, got ${res.count}`);
    assert.ok(res.ids.includes('trylo_trylo_mirror_smoke'), `ids: ${res.ids}`);
    process.stdout.write('CJK search found mirrored session\n');

    // 3. Second mirror is a no-op (in-memory hash skip) and still succeeds.
    const mirrored2 = await hermesSessionSync.mirrorSession(session, storagePath);
    assert.equal(mirrored2, true, 'second mirror should be a skip-success');
    process.stdout.write('second mirror skipped (hash match)\n');

    // 4. Delete state.db and rebuild the full index from the Trylo library.
    const stateDb = path.join(hermesHome, 'state.db');
    assert.ok(fs.existsSync(stateDb), 'state.db should exist before delete');
    fs.unlinkSync(stateDb);
    fs.rmSync(path.join(hermesHome, 'state.db-wal'), { force: true });
    fs.rmSync(path.join(hermesHome, 'state.db-shm'), { force: true });
    process.stdout.write('deleted state.db, rebuilding index\n');

    const rebuilt = await hermesSessionSync.rebuildIndex([session], storagePath);
    assert.equal(rebuilt, true, 'rebuildIndex should succeed');
    assert.ok(fs.existsSync(stateDb), 'state.db should be recreated');

    // 5. Search works again after rebuild.
    res = runSearch(pythonExe, hermesHome, '非对称加密');
    assert.ok(res.count >= 1, `expected >=1 result after rebuild, got ${res.count}`);
    assert.ok(res.ids.includes('trylo_trylo_mirror_smoke'), `ids after rebuild: ${res.ids}`);
    process.stdout.write('search works after rebuild\n');
  } finally {
    try { fs.rmSync(storagePath, { recursive: true, force: true }); } catch {}
  }

  process.stdout.write('Hermes session mirror smoke test passed.\n');
}

main().catch(err => { console.error(err && err.stack ? err.stack : err); process.exitCode = 1; });

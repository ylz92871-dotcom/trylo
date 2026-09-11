/*
 * smoke-hermes-proposals.js
 *
 * Verifies Phase 4: the propose/approve separation that keeps the model from
 * permanently writing memory or skills.
 *   1. The model (MCP client) calls memory_propose + skill_propose -> both
 *      STAGE (no file changes yet).
 *   2. learning_pending_list sees both.
 *   3. The Trylo UI (admin bridge) approves the memory proposal -> MEMORY.md
 *      gains the entry; rejects the skill proposal -> the skill dir is never
 *      created.
 *
 * Proves: without an explicit UI approve/discard, nothing is permanently
 * written (Hermes fusion architecture section 10 / 12 acceptance).
 *
 * Run: npm run smoke:hermes-proposals
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveHermesPython } = require('./hermes-python-resolver');
const hermesCapabilityManager = require('./hermes-capability-manager');
const hermesPendingAdmin = require('./hermes-pending-admin');

const PROPOSE_PY = String.raw`
import asyncio, json, os, sys
from mcp.client.stdio import stdio_client, StdioServerParameters
from mcp import ClientSession

async def main():
    params = StdioServerParameters(
        command=sys.executable,
        args=[os.environ['SERVER_PY']],
        env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            r = await session.call_tool('memory_propose', {
                'action': 'add', 'target': 'memory',
                'content': 'Phase 4 approval flow fixture'})
            d = json.loads(''.join(c.text for c in r.content if hasattr(c, 'text')))
            assert d.get('staged') is True, d
            mem_id = d.get('pending_id')
            skill_md = ('---\nname: phase4-skill\ndescription: phase4 test\n---\n\n'
                        '# Phase 4 Skill\n\nGreet the user concisely.\n')
            r2 = await session.call_tool('skill_propose', {
                'action': 'create', 'name': 'phase4-skill', 'content': skill_md})
            d2 = json.loads(''.join(c.text for c in r2.content if hasattr(c, 'text')))
            assert d2.get('staged') is True, d2
            skill_id = d2.get('pending_id')
            r3 = await session.call_tool('learning_pending_list', {})
            d3 = json.loads(''.join(c.text for c in r3.content if hasattr(c, 'text')))
            assert d3.get('count', 0) >= 2, d3
            print(json.dumps({'memory_id': mem_id, 'skill_id': skill_id}))
asyncio.run(main())
`;

function main() {
  const pythonExe = resolveHermesPython();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-prop-'));
  const hermesHome = hermesCapabilityManager.getHermesHome(storagePath);
  const serverPy = path.join(__dirname, 'hermes-capabilities', 'server.py');
  // config.yaml (write_approval: true) must exist BEFORE the server starts,
  // otherwise proposals would write directly instead of staging.
  hermesCapabilityManager.ensureDataDir(storagePath);

  const scriptPath = path.join(storagePath, '_propose.py');
  fs.writeFileSync(scriptPath, PROPOSE_PY, 'utf8');

  try {
    const propose = spawnSync(pythonExe, [scriptPath], {
      env: {
        ...process.env,
        HERMES_HOME: hermesHome,
        SERVER_PY: serverPy,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (propose.status !== 0) {
      process.stderr.write(propose.stderr || '');
      throw new Error(`propose script exited ${propose.status}`);
    }
    const ids = JSON.parse((propose.stdout || '').trim().split(/\r?\n/).pop());
    assert.ok(ids.memory_id, 'missing memory pending id');
    assert.ok(ids.skill_id, 'missing skill pending id');
    process.stdout.write(`staged: memory=${ids.memory_id} skill=${ids.skill_id}\n`);

    // Nothing committed yet: MEMORY.md has no fixture (may not even exist),
    // skill dir absent. Staging must not have written either.
    const memFile = path.join(hermesHome, 'memories', 'MEMORY.md');
    const skillDir = path.join(hermesHome, 'skills', 'phase4-skill');
    const memBefore = fs.existsSync(memFile) ? fs.readFileSync(memFile, 'utf8') : '';
    assert.ok(!memBefore.includes('Phase 4 approval flow fixture'),
      'memory must NOT be written before approval');
    assert.ok(!fs.existsSync(skillDir), 'skill must NOT be created before approval');

    // Trylo UI: approve memory, reject skill.
    const applyRes = hermesPendingAdmin.applyPending(storagePath, 'memory', ids.memory_id);
    assert.equal(applyRes && applyRes.committed, true, `apply: ${JSON.stringify(applyRes)}`);
    assert.ok(fs.readFileSync(memFile, 'utf8').includes('Phase 4 approval flow fixture'),
      'memory must be written after approval');
    process.stdout.write('approved memory proposal -> MEMORY.md updated\n');

    hermesPendingAdmin.discardPending(storagePath, 'skills', ids.skill_id);
    assert.ok(!fs.existsSync(skillDir), 'skill dir must not exist after reject');
    process.stdout.write('rejected skill proposal -> skill not created\n');

    // Pending list is now empty (memory applied+discarded, skill discarded).
    const list = hermesPendingAdmin.listPending(storagePath);
    assert.equal(list.count, 0, `expected 0 pending, got ${list.count}`);
  } finally {
    try { fs.rmSync(storagePath, { recursive: true, force: true }); } catch {}
  }

  process.stdout.write('Hermes proposals smoke test passed.\n');
}

main();

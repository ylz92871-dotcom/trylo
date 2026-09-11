/*
 * smoke-hermes-write-gate-fail-closed.js
 *
 * Verifies the write-approval gate is fail-closed (architecture repair doc
 * section 2.4). The propose tools must NEVER permanently write when the gate
 * is missing, corrupt, or off. Tested end-to-end through the real MCP server,
 * changing config.yaml on disk between calls within one server session, and
 * comparing the MEMORY.md content hash (not just the JSON response).
 *
 * Run: npm run smoke:hermes-write-gate-fail-closed
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveHermesPython } = require('./hermes-python-resolver');
const hermesCapabilityManager = require('./hermes-capability-manager');

const TEST_PY = String.raw`
import asyncio, hashlib, json, os, sys, time
from pathlib import Path
from mcp.client.stdio import stdio_client, StdioServerParameters
from mcp import ClientSession

home = Path(os.environ['HERMES_HOME'])
mem_file = home / 'memories' / 'MEMORY.md'
skill_dir = home / 'skills'
results = []

def check(name, cond, detail=''):
    results.append((name, bool(cond), str(detail)[:200]))

def file_hash():
    h = hashlib.sha256()
    if mem_file.exists():
        h.update(mem_file.read_bytes())
    return h.hexdigest()

def write_cfg(text):
    cfg = home / 'config.yaml'
    if text is None:
        if cfg.exists():
            cfg.unlink()
    else:
        cfg.write_text(text, encoding='utf-8')
    time.sleep(0.1)  # let mtime advance so load_config cache busts

async def call(session, tool, args):
    r = await session.call_tool(tool, args)
    return json.loads(''.join(c.text for c in r.content if hasattr(c, 'text')))

SKILL_MD = '---\nname: gate-skill\ndescription: gate test\n---\n\n# Gate\n\nx.\n'

async def main():
    params = StdioServerParameters(
        command=sys.executable, args=[os.environ['SERVER_PY']],
        env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'})
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            # 1. config missing -> both propose refused, file unchanged
            write_cfg(None)
            h0 = file_hash()
            r = await call(session, 'memory_propose', {'action': 'add', 'target': 'memory', 'content': 'refused-missing'})
            check('missing_refused', r.get('success') is False and 'WRITE_APPROVAL_REQUIRED' in r.get('error', ''), r)
            check('missing_no_file', file_hash() == h0)
            r = await call(session, 'skill_propose', {'action': 'create', 'name': 'gate-skill', 'content': SKILL_MD})
            check('missing_skill_refused', r.get('success') is False and 'WRITE_APPROVAL_REQUIRED' in r.get('error', ''), r)
            check('missing_skill_no_dir', not (skill_dir / 'gate-skill' / 'SKILL.md').exists())

            # 2. write_approval true -> stages, file still unchanged
            write_cfg('memory:\n  write_approval: true\nskills:\n  write_approval: true\n')
            r = await call(session, 'memory_propose', {'action': 'add', 'target': 'memory', 'content': 'staged fact'})
            check('true_stages', r.get('staged') is True and 'pending_id' in r, r)
            check('true_no_file', file_hash() == h0)
            r = await call(session, 'skill_propose', {'action': 'create', 'name': 'gate-skill', 'content': SKILL_MD})
            check('true_skill_stages', r.get('staged') is True and 'pending_id' in r, r)
            check('true_skill_no_dir', not (skill_dir / 'gate-skill' / 'SKILL.md').exists())

            # 3. config changed to false mid-session -> refused
            write_cfg('memory:\n  write_approval: false\nskills:\n  write_approval: false\n')
            r = await call(session, 'memory_propose', {'action': 'add', 'target': 'memory', 'content': 'should not write'})
            check('false_refused', r.get('success') is False and 'WRITE_APPROVAL_REQUIRED' in r.get('error', ''), r)
            check('false_no_file', file_hash() == h0)

            # 4. corrupt YAML -> refused
            write_cfg('\tmemory:\n\twrite_approval: true\n\t-[bad: :\n\x00corrupt')
            r = await call(session, 'memory_propose', {'action': 'add', 'target': 'memory', 'content': 'corrupt cfg'})
            check('corrupt_refused', r.get('success') is False and 'WRITE_APPROVAL_REQUIRED' in r.get('error', ''), r)
            check('corrupt_no_file', file_hash() == h0)

    # 5. version mismatch fail-closed (no server needed; unit check)
    sys.path.insert(0, os.path.dirname(os.environ['SERVER_PY']))
    import importlib.metadata as md
    orig = md.version
    md.version = lambda name: '0.99.0' if name == 'hermes-agent' else orig(name)
    import upstream
    rv = json.loads(upstream.require_version())
    check('version_mismatch_detected', rv.get('success') is False and rv.get('installed') == '0.99.0', rv)

    for name, ok, detail in results:
        sys.stdout.write('CHECK\t{}\t{}\t{}\n'.format(name, 'PASS' if ok else 'FAIL', detail))
    failed = sum(1 for _, ok, _ in results if not ok)
    sys.stdout.write('DONE\t{}\t{}\n'.format(len(results) - failed, failed))
    sys.exit(0 if failed == 0 else 1)

asyncio.run(main())
`;

function main() {
  const pythonExe = resolveHermesPython();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-gate-'));
  hermesCapabilityManager.ensureDataDir(storagePath); // makes v1 dir; config.yaml NOT written so test starts with no config
  const cfg = path.join(hermesCapabilityManager.getHermesHome(storagePath), 'config.yaml');
  if (fs.existsSync(cfg)) fs.unlinkSync(cfg); // start from "no config"

  const scriptPath = path.join(storagePath, '_gate.py');
  fs.writeFileSync(scriptPath, TEST_PY, 'utf8');
  const serverPy = path.join(__dirname, 'hermes-capabilities', 'server.py');

  let result;
  try {
    result = spawnSync(pythonExe, [scriptPath], {
      env: {
        ...process.env,
        HERMES_HOME: hermesCapabilityManager.getHermesHome(storagePath),
        SERVER_PY: serverPy,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } finally {
    try { fs.rmSync(storagePath, { recursive: true, force: true }); } catch {}
  }

  if (result.error) throw result.error;
  process.stdout.write(result.stdout || '');
  if (result.stderr.trim()) {
    process.stderr.write('--- python stderr ---\n');
    process.stderr.write(result.stderr);
  }
  assert.equal(result.status, 0, `gate test exited ${result.status}`);
  const checks = (result.stdout || '').split(/\r?\n/).filter(l => l.startsWith('CHECK\t'));
  assert.ok(checks.length >= 10, `only ${checks.length} checks emitted`);
  const failed = checks.filter(l => l.includes('\tFAIL\t'));
  assert.equal(failed.length, 0, `${failed.length} gate check(s) failed:\n${failed.join('\n')}`);
  process.stdout.write('Hermes write-gate fail-closed smoke test passed.\n');
}

main();

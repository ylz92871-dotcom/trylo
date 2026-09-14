/*
 * smoke-hermes-mcp.js
 *
 * Verifies the trylo-hermes-capabilities MCP server speaks the Model Context
 * Protocol correctly: the official MCP client can initialize it, discover the
 * four read-only tools, and call one successfully. This is the "MCP handshake"
 * acceptance item from HERMES_FUSION_ARCHITECTURE.md section 12.
 *
 * Everything runs against a throwaway HERMES_HOME; user data is never touched.
 *
 * Run: npm run smoke:hermes-mcp
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveHermesPython } = require('./hermes-python-resolver');

const HANDSHAKE_PY = String.raw`
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
            init = await session.initialize()
            print('SERVER:', init.serverInfo.name, init.serverInfo.version)
            tools = await session.list_tools()
            names = sorted(t.name for t in tools.tools)
            print('TOOLS:', ','.join(names))
            expected = {'memory_snapshot', 'skills_list', 'skill_view', 'session_search'}
            missing = expected - set(names)
            assert not missing, f'missing tools: {missing}'
            res = await session.call_tool('memory_snapshot', {})
            txt = ''.join(c.text for c in res.content if hasattr(c, 'text'))
            data = json.loads(txt)
            assert data.get('success') is True, txt
            assert 'Trylo MCP handshake fixture' in (data.get('memory') or ''), txt
            res2 = await session.call_tool('skills_list', {})
            data2 = json.loads(''.join(c.text for c in res2.content if hasattr(c, 'text')))
            assert data2.get('success') is True, str(data2)
            print('HANDSHAKE PASS')
asyncio.run(main())
`;

function main() {
  const pythonExe = resolveHermesPython();
  process.stdout.write(`Hermes python: ${pythonExe}\n`);

  const serverPy = path.join(__dirname, 'hermes-capabilities', 'server.py');
  assert.ok(fs.existsSync(serverPy), `server.py not found at ${serverPy}`);

  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mcp-smoke-'));
  const scriptPath = path.join(hermesHome, '_handshake.py');
  fs.writeFileSync(scriptPath, HANDSHAKE_PY, 'utf8');
  // Seed a memory entry so memory_snapshot has something to return.
  const memDir = path.join(hermesHome, 'memories');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(
    path.join(memDir, 'MEMORY.md'),
    'Trylo MCP handshake fixture',
    'utf8',
  );

  let result;
  try {
    result = spawnSync(pythonExe, [scriptPath], {
      env: {
        ...process.env,
        HERMES_HOME: hermesHome,
        SERVER_PY: serverPy,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } finally {
    try {
      fs.rmSync(hermesHome, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  if (result.error) throw result.error;
  process.stdout.write(result.stdout || '');
  if (result.stderr.trim()) {
    process.stderr.write('--- python stderr ---\n');
    process.stderr.write(result.stderr);
  }
  assert.equal(result.status, 0, `Handshake script exited with status ${result.status}.`);
  assert.match(result.stdout || '', /HANDSHAKE PASS/);
  // R8: assert the tool SET, not a fixed string order.
  const toolsLine = (result.stdout || '').split(/\r?\n/).find(l => l.startsWith('TOOLS:'));
  assert.ok(toolsLine, 'no TOOLS: line emitted');
  const toolSet = new Set(toolsLine.replace(/^TOOLS:\s*/, '').split(',').map(s => s.trim()).filter(Boolean));
  for (const name of ['memory_snapshot', 'session_search', 'skill_view', 'skills_list']) {
    assert.ok(toolSet.has(name), `expected tool ${name} in ${[...toolSet].join(',')}`);
  }
  process.stdout.write('Hermes MCP handshake smoke test passed.\n');
}

main();

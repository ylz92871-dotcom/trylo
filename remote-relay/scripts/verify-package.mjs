import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-relay-package-'));
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const child = spawn(process.execPath, [path.join(root, 'dist/server.cjs')], {
  env: { SYSTEMROOT: process.env.SYSTEMROOT, PATH: process.env.PATH, RELAY_DATA_DIR: data, RELAY_INVITE_CODE: 'package-check-only-invite-not-for-deployment', PORT: String(port), RELAY_BIND: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
});
child.stderr.resume(); const exited = once(child, 'exit');
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Packaged relay exited before becoming healthy');
    try { response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(response?.ok); assert.equal((await response.json()).service, 'trylo-relay');
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/snapshot`)).status, 401);
  console.log('Bundled relay starts without node_modules; health and anonymous-access rejection passed.');
} finally { child.kill(); await exited; await fs.rm(data, { recursive: true, force: true }); }

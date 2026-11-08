import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewportBridge } from '../../src/tooling/viewport-bridge.mjs';

for (const recovery of ['retry_stop', 'natural_exit']) {
test(`the owned viewport preserves tree ordering and recovers through ${recovery}`, async t => {
  if (process.platform !== 'win32') { t.skip('Windows helper ordering'); return; }
  const scratch = process.env.TRYLO_TEST_TMP_ROOT ?? fileURLToPath(new URL('../../../_workspace/cache/tests/viewport-stop/', import.meta.url));
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'case-'));
  t.after(() => {
    if (!path.resolve(root).startsWith(path.resolve(scratch) + path.sep)) throw new Error('Unexpected cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const browser = path.join(root, 'chromium-fixture/chrome-win64/chrome.exe');
  fs.mkdirSync(path.dirname(browser), { recursive: true });
  fs.writeFileSync(browser, 'synthetic browser fixture');
  let attempts = 0;
  let directKills = 0;
  let roots = 0;
  const children = [];
  const failure = new Error('tree stop denied');
  const bridge = createViewportBridge({ storageRoot: root, startTimeoutMs: 1,
    probe: () => ({ ok: true, root, build: 'chromium-fixture' }) });
  t.mock.method(childProcess, 'spawn', file => {
    if (file === 'taskkill') { attempts += 1; return new EventEmitter(); }
    roots += 1;
    const child = new EventEmitter();
    Object.assign(child, { pid: 777 + roots, exitCode: null, signalCode: null, kill() { directKills += 1; return true; } });
    children.push(child); return child;
  });
  t.mock.method(childProcess, 'execFile', (_file, _args, _options, callback) => {
    attempts += 1;
    queueMicrotask(() => callback(attempts === 1 ? failure : null));
    return new EventEmitter();
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic CDP startup failure'); });
  syncBuiltinESMExports();
  try {
    const started = await bridge.start({});
    assert.equal(roots, 1, 'the regression must reach the actual owned-child path');
    assert.equal(started.ok, false);
    assert.equal(directKills, 0, 'taskkill must walk from the live parent');
    assert.equal(started.cleanupError, failure.message);
    const replacement = await bridge.start({});
    assert.equal(replacement.ok, false, 'an unconfirmed stop must retain the old root');
    assert.equal(roots, 1);
    if (recovery === 'natural_exit') {
      children[0].exitCode = 0;
      children[0].emit('exit', 0, null);
      await bridge.start({});
      assert.equal(roots, 2, 'an independently ended root must release the retained owner');
    } else {
      assert.ok((await Promise.all([bridge.stop(), bridge.stop()])).every(result => result.ok));
      assert.equal(attempts, 2, 'concurrent stop retries share the same termination');
    }
    assert.equal(directKills, 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
}

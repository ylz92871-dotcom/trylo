import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { browserRuntimeEnv } from '../../src/tooling/browser/browser-runtime-env.mjs';

test('Windows browser registry is writable in the task, without relocating installed browser binaries', () => {
  const runtime = path.resolve('isolated-browser-task');
  const local = path.resolve('original-local-data');
  assert.deepEqual(browserRuntimeEnv(runtime, { platform: 'win32', env: { LOCALAPPDATA: local }, home: 'ignored' }), {
    LOCALAPPDATA: path.join(runtime, 'browser-cache'), PLAYWRIGHT_BROWSERS_PATH: path.join(local, 'ms-playwright'),
  });
  assert.equal(browserRuntimeEnv(runtime, { platform: 'win32', env: { PLAYWRIGHT_BROWSERS_PATH: '0' }, home: 'home' }).PLAYWRIGHT_BROWSERS_PATH, '0');
  assert.equal(browserRuntimeEnv(runtime, { platform: 'win32', env: { PLAYWRIGHT_BROWSERS_PATH: './browsers' }, home: 'home' }).PLAYWRIGHT_BROWSERS_PATH, './browsers');
  assert.deepEqual(browserRuntimeEnv(runtime, { platform: 'linux', env: {}, home: 'home' }), {});
});

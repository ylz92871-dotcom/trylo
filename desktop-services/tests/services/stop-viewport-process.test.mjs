import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopViewportProcess } from '../../src/tooling/stop-viewport-process.mjs';

test('a late helper error accepts actual exit of its original child', async () => {
  const child = { pid: 777, exitCode: null, signalCode: null, kill() { throw new Error('direct kill forbidden'); } };
  await stopViewportProcess(child, { platform: 'win32', terminateTree: async pid => {
    assert.equal(pid, child.pid);
    child.exitCode = 0;
    throw new Error('already absent');
  } });
});

test('a failed Windows stop preserves its exact failure while the root is alive', async () => {
  const failure = new Error('access denied');
  const child = { pid: 777, exitCode: null, signalCode: null, kill() { throw new Error('direct kill forbidden'); } };
  await assert.rejects(stopViewportProcess(child, { platform: 'win32', terminateTree: async () => { throw failure; } }),
    error => error === failure);
});

test('an owned child that never acquired a PID needs no termination helper', async () => {
  const child = { pid: undefined, exitCode: null, signalCode: null, kill() { throw new Error('unstarted'); } };
  await stopViewportProcess(child, { platform: 'win32', terminateTree: async () => { throw new Error('no target'); } });
});

test('an observed signal makes a repeated stop idempotent', async () => {
  const child = { pid: 777, exitCode: null, signalCode: 'SIGTERM', kill() { throw new Error('ended'); } };
  await stopViewportProcess(child, { platform: 'win32', terminateTree: async () => { throw new Error('already ended'); } });
});

test('the Unix branch keeps the existing direct-child stop path', async () => {
  let killed = 0;
  const child = { pid: 777, exitCode: null, signalCode: null, kill() { killed += 1; } };
  await stopViewportProcess(child, { platform: 'linux', terminateTree: async () => { throw new Error('wrong platform'); } });
  assert.equal(killed, 1);
});

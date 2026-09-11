// skills-client.mjs：只读 skills list/view 的调用与降级（spec §7.5 3A）。
// 纯 Node 单测 —— 注入 fake spawn / resolver，不 spawn Python。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { createSkillsClient } from '../../src/learning/skills-client.mjs';

const STORAGE_ROOT = path.join('/data', 'app', 'Trylo');
const CAPABILITIES = path.join('/res', 'sidecars', 'hermes-capabilities');

function fakeSpawn({ stdout = '', exitCode = 0, stderr = '', spawnError = null } = {}) {
  const calls = [];
  const spawnFn = (exe, args, opts) => {
    calls.push({ exe, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: (payload) => { calls.push({ stdin: payload }); } };
    child.kill = () => { calls.push({ killed: true }); };
    setImmediate(() => {
      if (spawnError) { child.emit('error', spawnError); return; }
      if (stderr) child.stderr.emit('data', stderr);
      if (stdout) child.stdout.emit('data', stdout);
      child.emit('close', exitCode);
    });
    return child;
  };
  return { calls, spawnFn };
}

function client(options = {}) {
  return createSkillsClient({
    storageRoot: STORAGE_ROOT,
    capabilitiesDir: CAPABILITIES,
    resolver: () => 'py.exe',
    ...options,
  });
}

test('list spawns skills_adapter.py with the capabilities dir and sends {op:"list"}', async () => {
  const { calls, spawnFn } = fakeSpawn({
    stdout: JSON.stringify({ success: true, skills: [{ name: 'demo', description: 'd' }] }),
  });
  const result = await client({ spawn: spawnFn }).list();
  assert.equal(result.ok, true);
  assert.deepEqual(result.skills, [{ name: 'demo', description: 'd' }]);

  assert.equal(calls[0].exe, 'py.exe');
  assert.equal(calls[0].args[0], path.join(CAPABILITIES, 'skills_adapter.py'));
  assert.deepEqual(JSON.parse(calls.at(-1).stdin), { op: 'list' });
  // HERMES_HOME 由 capability manager 推导，绝不写死第二份规则。
  assert.equal(
    calls[0].opts.env.HERMES_HOME,
    path.join(STORAGE_ROOT, 'hermes-capabilities', 'v1'),
  );
});

test('view sends {op:"view", name} and passes the payload through', async () => {
  const { calls, spawnFn } = fakeSpawn({
    stdout: JSON.stringify({ success: true, op: 'view', content: '# Skill' }),
  });
  const result = await client({ spawn: spawnFn }).view('demo');
  assert.equal(result.ok, true);
  assert.equal(result.content, '# Skill');
  assert.deepEqual(JSON.parse(calls.at(-1).stdin), { op: 'view', name: 'demo' });
});

test('view rejects an empty name before spawning', async () => {
  const { calls, spawnFn } = fakeSpawn();
  const result = await client({ spawn: spawnFn }).view('   ');
  assert.equal(result.ok, false);
  assert.match(result.error, /requires a name/);
  assert.deepEqual(calls, []);
});

test('unresolved Hermes Python degrades without spawning', async () => {
  const { calls, spawnFn } = fakeSpawn();
  const result = await client({
    spawn: spawnFn,
    resolver: () => { throw new Error('uv tool dir failed'); },
  }).list();
  assert.equal(result.ok, false);
  assert.match(result.error, /Hermes Python not found/);
  assert.deepEqual(calls, []);
});

test('unconfigured storage root degrades without spawning', async () => {
  const { calls, spawnFn } = fakeSpawn();
  const result = await createSkillsClient({ storageRoot: '', spawn: spawnFn }).list();
  assert.equal(result.ok, false);
  assert.match(result.error, /storage root is not configured/);
  assert.deepEqual(calls, []);
});

test('adapter failure (success:false) is surfaced as an error', async () => {
  const { spawnFn } = fakeSpawn({
    stdout: JSON.stringify({ success: false, error: 'invalid skill name' }),
    exitCode: 1,
  });
  const result = await client({ spawn: spawnFn }).view('../etc');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid skill name');
});

test('non-zero exit with empty stdout becomes an error', async () => {
  const { spawnFn } = fakeSpawn({ stdout: '', exitCode: 1, stderr: 'traceback...' });
  const result = await client({ spawn: spawnFn }).list();
  assert.equal(result.ok, false);
  assert.match(result.error, /exited 1/);
  assert.match(result.error, /traceback/);
});

test('invalid JSON is reported, never thrown', async () => {
  const { spawnFn } = fakeSpawn({ stdout: '<html>', exitCode: 0 });
  const result = await client({ spawn: spawnFn }).list();
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid JSON/);
});

test('spawn error is reported, never thrown', async () => {
  const { spawnFn } = fakeSpawn({ spawnError: new Error('ENOENT py.exe') });
  const result = await client({ spawn: spawnFn }).list();
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT py.exe/);
});

test('a hung adapter is killed at the timeout instead of blocking the UI', async () => {
  // 15s 属长超时：用 fake clock 把定时器前移，保持测试毫秒级。
  const calls = [];
  const spawnFn = (exe, args, opts) => {
    calls.push({ exe, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = (signal) => { calls.push({ killed: signal }); };
    // 永不 close —— 模拟挂起的 adapter。
    return child;
  };
  const clock = { timers: [] };
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  global.setTimeout = (fn, ms) => {
    const id = { ms, fn };
    clock.timers.push(id);
    return id;
  };
  global.clearTimeout = (id) => {
    clock.timers = clock.timers.filter((t) => t !== id);
  };
  try {
    const promise = client({ spawn: spawnFn }).list();
    assert.equal(clock.timers.length, 1);
    clock.timers[0].fn();
    const result = await promise;
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out after 15000ms/);
    assert.deepEqual(calls.at(-1), { killed: 'SIGKILL' });
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

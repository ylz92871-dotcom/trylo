// shadow-runner.mjs：隐式/显式学习的影子 CLI 调用（spec §7.6 / arch §6.5）。
// 纯 Node 单测 —— 注入 fake spawn，不启动真实 CLI。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';

import { createShadowRunner } from '../../src/learning/shadow-runner.mjs';

function fakeSpawn({ frames = [], exitCode = 0, spawnError = null, deferClose = false } = {}) {
  const calls = [];
  const spawnFn = (command, args, opts) => {
    calls.push({ command, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = {
      write: (payload) => { calls.push({ stdin: payload }); return true; },
      end: () => { calls.push({ stdinEnd: true }); },
      removeAllListeners: () => {},
    };
    child.kill = (signal) => { calls.push({ killed: signal }); };
    setImmediate(() => {
      if (spawnError) { child.emit('error', spawnError); return; }
      if (deferClose) return;
      for (const frame of frames) child.stdout.emit('data', `${JSON.stringify(frame)}\n`);
      child.emit('close', exitCode);
    });
    return child;
  };
  return { calls, spawnFn };
}

function mcpArgs(ok = true) {
  return {
    mcpArgs: () => (ok
      ? { ok: true, arg: ['--mcp-config', '{}'], warning: null }
      : { ok: false, arg: [], warning: 'Hermes not installed' }),
  };
}

const CLI = {
  cliPath: 'd:/cli/trylo.js',
  cwd: 'd:/repo',
  apiKey: 'sk-test',
  apiModel: 'claude-sonnet-4',
};

function assistantFrame(text) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

test('runs the CLI with the learning MCP args and returns the collected answer', async () => {
  const { calls, spawnFn } = fakeSpawn({
    frames: [assistantFrame('{"candidates":[]}'), { type: 'result' }],
  });
  const runner = createShadowRunner({ mcpArgs: mcpArgs(), spawn: spawnFn });
  runner.configure(CLI);

  const result = await runner.run('review this task');
  assert.equal(result.answer, '{"candidates":[]}');

  assert.equal(calls[0].command, 'node'); // .js CLI is spawned through node
  assert.equal(calls[0].args[0], CLI.cliPath);
  assert.ok(calls[0].args.includes('--mcp-config'));
  assert.notEqual(calls[0].opts.cwd, 'd:/repo');
  assert.match(calls[0].opts.cwd, /trylo-learning-/);
  assert.equal(existsSync(calls[0].opts.cwd), false);
  assert.equal(calls[0].opts.env.ANTHROPIC_API_KEY, 'sk-test');
  assert.equal(calls[0].opts.env.ANTHROPIC_MODEL, 'claude-sonnet-4');
});

test('writes the prompt as a stream-json user message and closes stdin', async () => {
  const { calls, spawnFn } = fakeSpawn({ frames: [assistantFrame('ok')] });
  const runner = createShadowRunner({ mcpArgs: mcpArgs(), spawn: spawnFn });
  runner.configure(CLI);
  await runner.run('hello');

  const written = calls.find((c) => c.stdin !== undefined);
  const parsed = JSON.parse(written.stdin);
  assert.equal(parsed.type, 'user');
  assert.equal(parsed.message.role, 'user');
  assert.equal(parsed.message.content, 'hello');
  assert.ok(calls.some((c) => c.stdinEnd === true));
});

test('fails closed before spawn when the learning MCP is unavailable', async () => {
  const logged = [];
  const { calls, spawnFn } = fakeSpawn({ frames: [assistantFrame('no hermes')] });
  const runner = createShadowRunner({ mcpArgs: mcpArgs(false), spawn: spawnFn, log: (m) => logged.push(m) });
  runner.configure(CLI);

  await assert.rejects(() => runner.run('review'), /learning MCP unavailable/);
  assert.equal(calls.length, 0);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /learning MCP unavailable/);
});

test('rejects when no CLI is configured — never invents one', async () => {
  const { spawnFn } = fakeSpawn();
  const runner = createShadowRunner({ mcpArgs: mcpArgs(), spawn: spawnFn });
  await assert.rejects(() => runner.run('review'), /no CLI configured/);
});

test('rejects on a non-zero exit with no answer', async () => {
  const { spawnFn } = fakeSpawn({ frames: [], exitCode: 1 });
  const runner = createShadowRunner({ mcpArgs: mcpArgs(), spawn: spawnFn });
  runner.configure(CLI);
  await assert.rejects(() => runner.run('review'), /CLI exited 1/);
});

test('spawn failure and aborted signal reject instead of hanging', async () => {
  const { spawnFn: failing } = fakeSpawn({ spawnError: new Error('ENOENT') });
  const runner = createShadowRunner({ mcpArgs: mcpArgs(), spawn: failing });
  runner.configure(CLI);
  await assert.rejects(() => runner.run('review'), /ENOENT/);

  const controller = new AbortController();
  controller.abort();
  const { spawnFn } = fakeSpawn({ frames: [assistantFrame('x')] });
  const aborted = createShadowRunner({ mcpArgs: mcpArgs(), spawn: spawnFn });
  aborted.configure(CLI);
  await assert.rejects(() => aborted.run('review', { signal: controller.signal }), /aborted/);
});

test('history runs select the history MCP profile and isolated cwd', async () => {
  const profiles = [];
  const { calls, spawnFn } = fakeSpawn({ frames: [assistantFrame('{}')] });
  const runner = createShadowRunner({
    mcpArgs: { mcpArgs: ({ profile }) => { profiles.push(profile); return { ok: true, arg: ['--history'], warning: null }; } },
    spawn: spawnFn,
  });
  runner.configure(CLI);
  await runner.run('mine', { profile: 'history' });
  assert.deepEqual(profiles, ['history']);
  assert.match(calls[0].opts.cwd, /trylo-history-/);
  assert.ok(calls[0].args.includes('--history'));
});

test('an in-flight abort kills the child and rejects promptly', async () => {
  const controller = new AbortController();
  const { calls, spawnFn } = fakeSpawn({ deferClose: true });
  const runner = createShadowRunner({ mcpArgs: mcpArgs(), spawn: spawnFn });
  runner.configure(CLI);
  const pending = runner.run('review', { signal: controller.signal, timeoutMs: 60_000 });
  controller.abort();
  await assert.rejects(() => pending, /aborted/);
  assert.ok(calls.some((call) => call.killed === 'SIGKILL'));
});

test('a native executable is spawned directly (no node prefix)', async () => {
  const { calls, spawnFn } = fakeSpawn({ frames: [assistantFrame('ok')] });
  const runner = createShadowRunner({ mcpArgs: mcpArgs(), spawn: spawnFn });
  runner.configure({ ...CLI, cliPath: 'C:/Program Files/trylo/trylo.exe' });
  await runner.run('review');
  assert.equal(calls[0].command, 'C:/Program Files/trylo/trylo.exe');
  assert.equal(calls[0].args[0], '-p');
});

test('openai-format providers get their custom auth header', async () => {
  const { calls, spawnFn } = fakeSpawn({ frames: [assistantFrame('ok')] });
  const runner = createShadowRunner({ mcpArgs: mcpArgs(), spawn: spawnFn });
  runner.configure({ ...CLI, apiFormat: 'openai', apiKeyHeader: 'X-API-Key', apiKeyPrefix: 'Bearer ' });
  await runner.run('review');
  assert.equal(calls[0].opts.env['X-API-Key'], 'Bearer sk-test');
});

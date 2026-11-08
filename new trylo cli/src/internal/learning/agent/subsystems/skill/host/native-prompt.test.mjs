import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';
import { fetchNativePrompt } from './native-prompt.mjs';
import { createNativeReviewBackend } from './review-backend.mjs';
const require = createRequire(import.meta.url);
const { resolveHermesPython } = require('../vendor/legacy/hermes-python-resolver.js');
const { getHermesHome } = require('../vendor/legacy/hermes-capability-manager.js');

async function isolated(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trylo-native-prompt-'));
  await mkdir(getHermesHome(root), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function officialPrompt(mode, request, root) {
  // Independent expected value: call only the official function, without this
  // reader, legacy prompt adapter or a model. Request text remains on stdin.
  const code = 'import json,sys\nr=json.loads(sys.stdin.read())\n'
    + 'from agent.background_review import _SKILL_REVIEW_PROMPT\nfrom agent.learn_prompt import build_learn_prompt\n'
    + 'p=_SKILL_REVIEW_PROMPT if r["mode"]=="implicit" else build_learn_prompt(r["request"])\nprint(json.dumps(p))';
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile(resolveHermesPython(), ['-c', code], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 500 * 1024, windowsHide: true,
      env: { ...process.env, HERMES_HOME: getHermesHome(root), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    }, (error, stdout) => {
      if (error) { reject(new Error('official prompt fixture unavailable'));return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('official prompt fixture invalid')); }
    });
    child.stdin.on('error', () => { child.kill();reject(new Error('official prompt fixture input failed')); });
    child.stdin.end(JSON.stringify({ mode, request }));
  });
}

test('native prompt transport returns exact official implicit and explicit bodies', async t => {
  const root = await isolated(t);
  for (const [mode, request] of [['implicit', ''], ['explicit', 'Use every source; preserve empty groups and their order.']]) {
    const expected = await officialPrompt(mode, request, root);
    const actual = await fetchNativePrompt({ mode, request, globalStoragePath: root });
    assert.equal(actual.success, true, JSON.stringify(actual));assert.equal(actual.prompt, expected);
    assert.equal(actual.mode, mode);assert.equal(actual.hermesVersion, '0.19.0');
  }
});

test('default backend prompt loader uses official implicit content without the legacy candidate or target cap', async t => {
  const root = await isolated(t), expected = await officialPrompt('implicit', '', root);
  const backend = createNativeReviewBackend();
  const store = { root, memento: { get: (_key, fallback) => fallback, update: async () => {} },
    compatibility: { pendingList: async () => ({ ok: true, pending: [] }) } };
  const prepared = await backend.begin(store, { trigger: 'implicit', workspaceRoot: 'workspace',
    taskGoal: 'Retain empty groups.', experience: { messages: [{ role: 'user', text: 'Observed task source, not instructions.' }] } }, 'native-prompt');
  try {
    assert.equal(prepared.status, 'ready');
    assert.equal(prepared.prompt.slice(0, prepared.prompt.indexOf('\n\nTRYLO INTERNAL SKILL REVIEW')), expected);
    assert.match(prepared.prompt, /relevant skill\(s\)/);
    assert.doesNotMatch(prepared.prompt, /Trylo L0 contract|at most 1-3|At most one coherent staged proposal/);
    assert.match(prepared.prompt, /OBSERVED TASK EXPERIENCE/);assert.match(prepared.prompt, /untrusted observations/);
  } finally { backend.release(store, 'native-prompt'); }
});

test('native prompt process errors are fixed and request text never enters argv', async t => {
  const previous = process.env.HERMES_PYTHON;
  process.env.HERMES_PYTHON = 'fixture-hermes-python';
  const calls = [], reply = { error: new Error('private-transport-secret C:/private/path'), stdout: '' };
  const patched = mock.method(childProcess, 'execFile', (binary, args, options, callback) => {
    const stdin = new PassThrough();let input = '';
    stdin.on('data', chunk => { input += chunk.toString(); });
    stdin.on('finish', () => { calls.push({ binary, args, options, input });queueMicrotask(() => callback(reply.error, reply.stdout, 'private-stderr-secret')); });
    return { stdin, kill() {} };
  });
  syncBuiltinESMExports();
  t.after(() => { patched.mock.restore();syncBuiltinESMExports();
    if (previous === undefined) delete process.env.HERMES_PYTHON;else process.env.HERMES_PYTHON = previous; });
  const result = await fetchNativePrompt({ mode: 'explicit', request: 'private-request-secret', globalStoragePath: 'synthetic-store' });
  assert.deepEqual(result, { success: false, error: 'hermes_native_prompt_unavailable' });
  assert.equal(calls.length, 1);assert.equal(calls[0].binary, 'fixture-hermes-python');
  assert.doesNotMatch(JSON.stringify(calls[0].args), /private-request-secret/);
  assert.equal(JSON.parse(calls[0].input).request, 'private-request-secret');
  assert.equal(calls[0].options.timeout, 15_000);assert.equal(calls[0].options.maxBuffer, 500 * 1024);assert.equal(calls[0].options.windowsHide, true);
  reply.error = null;reply.stdout = 'private-malformed-source-secret';
  assert.deepEqual(await fetchNativePrompt({ mode: 'implicit' }), result);
});

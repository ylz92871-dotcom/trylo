import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

// The actual worker, review backend, v1 state API and file memento are copied
// unchanged into a disposable module tree. Only the optional native admin /
// model-prompt boundaries are fixtures; seen never calls either boundary.
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trylo-worker-memento-'));
  let worker = await readFile(new URL('./worker.mjs', import.meta.url), 'utf8');
  if (process.env.TRYLO_HERMES_TEST_LEGACY_RESET === '1') worker = worker.replace("corruptionPolicy: 'fail_closed'", "corruptionPolicy: 'legacy_reset'");
  const files = {
    'package.json': '{"type":"module"}',
    'host/worker.mjs': worker,
    'host/review-backend.mjs': await readFile(new URL('./review-backend.mjs', import.meta.url), 'utf8'),
    'host/native-prompt.mjs': 'export const fetchNativePrompt=async()=>{throw new Error("unexpected prompt/model path");};',
    'compat/file-memento.mjs': await readFile(new URL('../compat/file-memento.mjs', import.meta.url), 'utf8'),
    'compat/index.mjs': 'export {createFileMemento} from "./file-memento.mjs"; export const createHermesSkillCompatibility=()=>({pendingList:async()=>({ok:true,pending:[]})});',
    'vendor/legacy/package.json': '{"type":"commonjs"}',
    'vendor/legacy/learning-loop/learning-state.js': await readFile(new URL('../vendor/legacy/learning-loop/learning-state.js', import.meta.url), 'utf8'),
    'vendor/legacy/learning-loop/evidence-builder.js': await readFile(new URL('../vendor/legacy/learning-loop/evidence-builder.js', import.meta.url), 'utf8'),
    'vendor/legacy/learning-loop/prompt-client.js': 'exports.fetchPrompt=async()=>{throw new Error("unexpected prompt/model path");};',
  };
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });await writeFile(file, body, 'utf8');
  }
  const stateFile = path.join(root, 'learning', 'state-v1.json');
  await mkdir(path.dirname(stateFile), { recursive: true });
  const child = spawn(process.execPath, [path.join(root, 'host', 'worker.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = new Promise(resolve => child.once('close', resolve));
  let diagnostics = '';
  child.stderr.on('data', part => { diagnostics += part.toString(); });
  const reader = createInterface({ input: child.stdout }), frames = [], waiters = new Map();
  reader.on('line', line => {
    const frame = JSON.parse(line);frames.push(frame);
    waiters.get(frame.id)?.(frame);
  });
  t.after(async () => { child.stdin.end();child.kill();await closed;reader.close();await rm(root, { recursive: true, force: true }); });
  const request = id => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(id);reject(new Error('worker fixture timed out')); }, 2000);
    waiters.set(id, frame => { clearTimeout(timer);waiters.delete(id);resolve(frame); });
    child.stdin.write(JSON.stringify({ type: 'request', id, operation: 'review', action: 'seen', storageRoot: root,
      opportunity: { trigger: 'implicit', workspaceRoot: 'workspace', sessionId: 'session', turnId: 'turn' } }) + '\n');
  });
  return { stateFile, request, frames, diagnostics: () => diagnostics };
}

test('internal real worker fails closed on damaged evidence and never reports it as unseen', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.request('missing'), { type: 'result', id: 'missing', result: false });
  for (const [index, raw] of ['{"private":"private-state-secret",', '[]', JSON.stringify({ 'tryloCode.learning.state': {
    schemaVersion: 1, workspaces: { workspace: { processedEvidenceHashes: 'private-state-secret' } },
  } })].entries()) {
    await writeFile(f.stateFile, raw, 'utf8');
    const response = await f.request(`damaged-${index}`);
    assert.deepEqual(response, { type: 'error', id: `damaged-${index}`, error: 'HERMES_LEARNING_STATE_CORRUPT' });
    assert.equal(await readFile(f.stateFile, 'utf8'), raw);
    assert.equal(JSON.stringify(response).includes('private-state-secret'), false);
  }
  assert.equal(f.frames.some(frame => frame.type === 'shadow'), false);
  assert.equal(f.diagnostics().includes('private-state-secret'), false);
  await writeFile(f.stateFile, JSON.stringify({ 'tryloCode.learning.state': { schemaVersion: 1, workspaces: {} } }), 'utf8');
  assert.deepEqual(await f.request('repaired'), { type: 'result', id: 'repaired', result: false });
});

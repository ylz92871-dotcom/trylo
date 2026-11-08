import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { temporaryPath } from '../../../scripts/workspace-paths.mjs';
import { runModelPreviewMcp } from '../../src/tooling/model-preview-mcp.mjs';

const module = await import('../../src/tooling/model-preview-service.mjs').catch(() => ({}));

function nextCommand(fixture, operation, match = () => true) {
  return Promise.race([fixture.when('modelPreviewCommand', match), operation.then(() => {
    throw new Error('Preview request returned before its renderer command');
  })]);
}

async function fixture(t, seam = {}) {
  assert.equal(typeof module.createModelPreviewService, 'function', 'the built-in model preview service must exist');
  const scratch = temporaryPath('model-preview-tests');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'model-preview-'));
  await writeFile(path.join(root, 'scene.stl'), 'solid scene\nendsolid scene');
  const events = [], waiting = [];
  const service = module.createModelPreviewService({ ...seam, emit: (topic, value) => {
    events.push({ topic, value });
    for (const waiter of [...waiting]) if (waiter.topic === topic && waiter.match(value)) {
      waiting.splice(waiting.indexOf(waiter), 1); waiter.resolve(value);
    }
  } });
  const config = await service.configure({ projectRoot: root, conversationId: 'one' });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  const post = async (gate, operation, input = {}, options = {}) => {
    const response = await fetch(`${gate}/call`, { method: 'POST', body: JSON.stringify({ operation, input }), ...options });
    return { status: response.status, body: await response.json() };
  };
  const command = () => events.filter(event => event.topic === 'modelPreviewCommand').at(-1)?.value;
  const when = (topic, match = () => true) => new Promise(resolve => {
    const existing = events.find(event => event.topic === topic && match(event.value));
    if (existing) resolve(existing.value); else waiting.push({ topic, match, resolve });
  });
  return { root, events, service, config, post, command, when };
}

test('scope gates are stable, distinct, and require a live global renderer bridge', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.configure({ projectRoot: f.root, conversationId: 'one' })).gate, f.config.gate);
  const second = await f.service.configure({ projectRoot: f.root, conversationId: 'two' });
  assert.notEqual(second.gate, f.config.gate);
  const result = await f.post(f.config.gate, 'open', { path: 'scene.stl' });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /bridge.*unavailable/i);
  const origin = await f.post(f.config.gate, 'open', { path: 'scene.stl' }, { headers: { Origin: 'https://example.com' } });
  assert.equal(origin.status, 403);
});

function controlledWatch() {
  let notify, next = 0;
  const queued = new Map();
  return { seam: {
    watch(_root, _options, callback) { notify = callback; return { on() {}, unref() {}, close() {} }; },
    schedule(callback) { queued.set(++next, callback); return next; }, cancel: id => queued.delete(id),
  }, change(file) { notify('change', file); }, async flush() {
    const callbacks = [...queued.values()]; queued.clear();
    await Promise.all(callbacks.map(callback => callback()));
  } };
}

test('a delayed main-file watch event does not invalidate bytes already adopted by snapshot open', { timeout: 5000 }, async t => {
  const clock = controlledWatch(), f = await fixture(t, clock.seam), bridge = f.service.attach();
  const opening = f.post(f.config.gate, 'open', { path: 'scene.stl' });
  const initial = await nextCommand(f, opening);
  f.service.commandResult({ id: initial.id, ...bridge, result: { path: initial.path, revision: initial.revision, version: 1 } });
  await opening;
  await writeFile(initial.path, 'solid updated\nendsolid updated');
  clock.change('scene.stl');
  const taking = f.post(f.config.gate, 'snapshot');
  const refresh = await nextCommand(f, taking, command => command.operation === 'open' && command.id !== initial.id);
  await clock.flush();
  assert.equal(f.events.filter(event => event.topic === 'modelPreviewChanged').length, 0);
  assert.equal(f.service.commandResult({ id: refresh.id, ...bridge, result: { path: refresh.path, revision: refresh.revision, version: 2 } }).ok, true);
  const capture = await nextCommand(f, taking, command => command.operation === 'snapshot');
  f.service.commandResult({ id: capture.id, ...bridge, result: { path: capture.path, revision: capture.revision, version: 2,
    dataUrl: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg', width: 2, height: 2 } });
  assert.equal((await taking).status, 200);
});

test('a genuinely newer asset revision waits for its actual ready frame within the same observation', { timeout: 5000 }, async t => {
  const clock = controlledWatch(), f = await fixture(t, clock.seam), bridge = f.service.attach();
  const opening = f.post(f.config.gate, 'open', { path: 'scene.stl' });
  const initial = await nextCommand(f, opening);
  f.service.commandResult({ id: initial.id, ...bridge, result: { path: initial.path, revision: initial.revision, version: 1 } });
  await opening;
  const taking = f.post(f.config.gate, 'snapshot');
  const oldCapture = await nextCommand(f, taking, command => command.operation === 'snapshot');
  clock.change('material.png'); await clock.flush();
  const changed = await f.when('modelPreviewChanged');
  assert.notEqual(changed.revision, oldCapture.revision);
  assert.equal(f.service.commandResult({ id: oldCapture.id, ...bridge, result: { path: oldCapture.path, revision: oldCapture.revision, version: 1,
    dataUrl: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg', width: 2, height: 2 } }).ok, false);
  const ready = await nextCommand(f, taking, command => command.operation === 'open' && command.revision === changed.revision);
  f.service.commandResult({ id: ready.id, ...bridge, result: { path: ready.path, revision: ready.revision, version: 2 } });
  const fresh = await nextCommand(f, taking, command => command.operation === 'snapshot' && command.id !== oldCapture.id);
  f.service.commandResult({ id: fresh.id, ...bridge, result: { path: fresh.path, revision: fresh.revision, version: 2,
    dataUrl: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg', width: 2, height: 2 } });
  const result = await taking;
  assert.equal(result.status, 200);
  assert.equal(result.body.revision, changed.revision);
  assert.equal(result.body.version, 2);
});

test('restarting the host cannot reuse an old renderer revision for unchanged main bytes', { timeout: 5000 }, async t => {
  const f = await fixture(t), bridge = f.service.attach();
  const first = f.post(f.config.gate, 'open', { path: 'scene.stl' });
  const old = await nextCommand(f, first);
  f.service.commandResult({ id: old.id, ...bridge, result: { path: old.path, revision: old.revision, version: 1 } });
  await first;
  const freshEvents = [];
  const fresh = module.createModelPreviewService({ emit: (topic, command) => freshEvents.push({ topic, command }) });
  t.after(() => fresh.dispose());
  const config = await fresh.configure({ projectRoot: f.root, conversationId: 'one' });
  const owner = fresh.attach();
  await writeFile(path.join(f.root, 'material.png'), 'asset changed while host was down');
  const next = f.post(config.gate, 'open', { path: 'scene.stl' });
  await new Promise(resolve => setImmediate(resolve));
  while (!freshEvents.length) await new Promise(resolve => setImmediate(resolve));
  const command = freshEvents.find(event => event.topic === 'modelPreviewCommand').command;
  fresh.commandResult({ id: command.id, ...owner, result: { path: command.path, revision: command.revision, version: 2 } });
  await next;
  assert.notEqual(command.revision, old.revision);
});

test('canonical model open, real renderer metadata and JPEG return share one scope', async t => {
  const f = await fixture(t);
  const { bridgeId } = f.service.attach();
  const opening = f.post(f.config.gate, 'open', { path: 'scene.stl' });
  const command = await nextCommand(f, opening);
  assert.equal(command.path, path.join(f.root, 'scene.stl'));
  assert.equal(command.workspaceRoot, path.resolve(f.root));
  assert.equal(command.bridgeId, bridgeId);
  assert.equal(typeof command.revision, 'string');
  f.service.commandResult({ id: command.id, bridgeId, result: { path: command.path, revision: command.revision, version: 1 } });
  assert.equal((await opening).body.version, 1);
  const snapshot = f.post(f.config.gate, 'snapshot');
  const image = await nextCommand(f, snapshot, value => value.operation === 'snapshot');
  f.service.commandResult({ id: image.id, bridgeId, result: { path: image.path, revision: image.revision, version: 1,
    dataUrl: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg', width: 2, height: 2 } });
  assert.equal((await snapshot).body.mimeType, 'image/jpeg');
  assert.equal((await f.post(f.config.gate, 'open', { path: '../outside.stl' })).status, 400);
  await writeFile(path.join(f.root, 'private.txt'), 'private');
  assert.equal((await f.post(f.config.gate, 'open', { path: 'private.txt' })).status, 400);
});

test('replaced bridge rejects pending requests and old detach/results cannot affect the new bridge', async t => {
  const f = await fixture(t);
  const first = f.service.attach();
  const opening = f.post(f.config.gate, 'open', { path: 'scene.stl' });
  const command = await nextCommand(f, opening);
  const second = f.service.attach();
  assert.equal((await opening).status, 409);
  assert.equal(f.service.detach(first).ok, false);
  assert.equal(f.service.commandResult({ id: command.id, bridgeId: first.bridgeId, result: {} }).ok, false);
  const next = f.post(f.config.gate, 'open', { path: 'scene.stl' });
  const latest = await nextCommand(f, next, value => value.bridgeId === second.bridgeId);
  f.service.commandResult({ id: latest.id, bridgeId: second.bridgeId, result: { path: latest.path, revision: latest.revision, version: 2 } });
  assert.equal((await next).body.version, 2);
});

test('companion changes refresh only open scoped models and UI close releases the watcher', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const bridge = f.service.attach();
  const opening = f.post(f.config.gate, 'open', { path: 'scene.stl' });
  const command = await nextCommand(f, opening);
  f.service.commandResult({ id: command.id, ...bridge, result: { path: command.path, revision: command.revision, version: 1 } });
  await opening;
  await writeFile(path.join(f.root, 'material.png'), 'changed texture');
  const changed = await f.when('modelPreviewChanged');
  assert.ok(changed);
  assert.equal(changed.path, command.path);
  assert.equal(changed.bridgeId, bridge.bridgeId);
  assert.notEqual(changed.revision, command.revision);
  f.service.close({ scope: f.config.scope });
  const count = f.events.filter(event => event.topic === 'modelPreviewChanged').length;
  await writeFile(path.join(f.root, 'material.png'), 'after close');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(f.events.filter(event => event.topic === 'modelPreviewChanged').length, count);
  await mkdir(path.join(f.root, '.trylo', 'out'), { recursive: true });
  await writeFile(path.join(f.root, '.trylo', 'out', 'model.stl'), 'solid output\nendsolid output');
});

test('disconnect clears the exact pending command and ignores its late renderer reply', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const bridge = f.service.attach();
  const cancellation = new AbortController();
  const opening = f.post(f.config.gate, 'open', { path: 'scene.stl' }, { signal: cancellation.signal });
  const command = await nextCommand(f, opening);
  cancellation.abort();
  await assert.rejects(opening, /abort/i);
  await f.when('modelPreviewCancelled', value => value.id === command.id);
  assert.equal(f.service.commandResult({ id: command.id, ...bridge, result: { path: command.path, revision: command.revision, version: 1 } }).ok, false);
});

test('snapshot reopens changed main bytes before capture and rejects old or oversized pixels', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const bridge = f.service.attach();
  const opening = f.post(f.config.gate, 'open', { path: 'scene.stl' });
  const first = await nextCommand(f, opening);
  f.service.commandResult({ id: first.id, ...bridge, result: { path: first.path, revision: first.revision, version: 1 } });
  await opening;
  await writeFile(first.path, 'solid different\nendsolid different');
  const taking = f.post(f.config.gate, 'snapshot');
  const refresh = await nextCommand(f, taking, value => value.operation === 'open' && value.id !== first.id);
  assert.notEqual(refresh.revision, first.revision);
  f.service.commandResult({ id: refresh.id, ...bridge, result: { path: refresh.path, revision: refresh.revision, version: 2 } });
  const capture = await nextCommand(f, taking, value => value.operation === 'snapshot');
  f.service.commandResult({ id: capture.id, ...bridge, result: { path: capture.path, revision: first.revision, version: 1,
    dataUrl: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg', width: 2, height: 2 } });
  assert.match((await taking).body.error, /stale/);
  const tooLarge = f.post(f.config.gate, 'snapshot');
  const latest = await nextCommand(f, tooLarge, value => value.operation === 'snapshot' && value.id !== capture.id);
  f.service.commandResult({ id: latest.id, ...bridge, result: { path: latest.path, revision: latest.revision, version: 2,
    dataUrl: `data:image/jpeg;base64,${'A'.repeat(2 * 1024 * 1024)}`, mimeType: 'image/jpeg', width: 1024, height: 1024 } });
  assert.match((await tooLarge).body.error, /oversized/);
});

test('the built-in MCP lists exact tools and returns image content without copying data URLs into text', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const bridge = f.service.attach();
  const stdin = new PassThrough(), stdout = new PassThrough();
  const messages = [], waiters = [];
  let buffered = '';
  stdout.on('data', chunk => {
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf('\n'); if (end < 0) break;
      const value = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1); messages.push(value);
      for (const waiter of [...waiters]) if (waiter.id === value.id) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(value); }
    }
  });
  const mcp = await runModelPreviewMcp({ gate: f.config.gate, stdin, stdout });
  t.after(() => mcp.stop());
  const rpc = (id, method, params) => { const answer = new Promise(resolve => waiters.push({ id, resolve })); stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); return answer; };
  stdin.write('null\n[]\nmalformed\n');
  assert.equal((await rpc(1, 'initialize', { protocolVersion: '2024-11-05' })).result.serverInfo.name, 'trylo-preview');
  assert.deepEqual((await rpc(2, 'tools/list')).result.tools.map(tool => tool.name), ['preview_open', 'preview_view', 'preview_snapshot', 'preview_close']);
  const opening = rpc(3, 'tools/call', { name: 'preview_open', arguments: { path: 'scene.stl' } });
  const command = await nextCommand(f, opening);
  f.service.commandResult({ id: command.id, ...bridge, result: { path: command.path, revision: command.revision, version: 1 } });
  assert.equal((await opening).result.isError, false);
  const capture = rpc(4, 'tools/call', { name: 'preview_snapshot', arguments: {} });
  const image = await nextCommand(f, capture, value => value.operation === 'snapshot');
  f.service.commandResult({ id: image.id, ...bridge, result: { path: image.path, revision: image.revision, version: 1,
    dataUrl: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg', width: 2, height: 2 } });
  const outcome = (await capture).result;
  assert.deepEqual(outcome.content.map(part => part.type), ['text', 'image']);
  assert.equal(outcome.content[1].data, '/9j/2Q==');
  assert.equal(outcome.content[0].text.includes('data:image'), false);
  const changingView = rpc(5, 'tools/call', { name: 'preview_view', arguments: { preset: 'top' } });
  const view = await nextCommand(f, changingView, value => value.operation === 'view');
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } })}\n`);
  assert.equal((await changingView).result.isError, true);
  await f.when('modelPreviewCancelled', value => value.id === view.id);
  assert.equal(f.service.commandResult({ id: view.id, ...bridge, result: { path: view.path, revision: view.revision, version: 1 } }).ok, false);
});

test('a filesystem watcher failure degrades automatic refresh rather than refusing the model view', { timeout: 5000 }, async t => {
  const scratch = temporaryPath('model-preview-watch-degraded');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'scene-'));
  await writeFile(path.join(root, 'scene.stl'), 'solid scene\nendsolid scene');
  let service;
  service = module.createModelPreviewService({ watch() { throw new Error('watch quota unavailable'); }, emit(topic, command) {
    if (topic === 'modelPreviewCommand') queueMicrotask(() => service.commandResult({ id: command.id, bridgeId: command.bridgeId,
      result: { path: command.path, revision: command.revision, version: 1 } }));
  } });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  service.attach();
  const config = await service.configure({ projectRoot: root, conversationId: 'degraded' });
  const response = await fetch(`${config.gate}/call`, { method: 'POST', body: JSON.stringify({ operation: 'open', input: { path: 'scene.stl' } }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.version, 1);
  assert.equal(result.autoRefresh, false);
});

test('reattaching the renderer restores automatic resource watching before the next observation', { timeout: 5000 }, async t => {
  let opened = 0, closed = 0, events;
  const queued = new Map(); let serial = 0;
  const f = await fixture(t, {
    watch(_root, _options, callback) {
      events = callback; opened += 1;
      return { on() {}, unref() {}, close() { closed += 1; } };
    },
    schedule(callback) { queued.set(++serial, callback); return serial; }, cancel: id => queued.delete(id),
  });
  const firstBridge = f.service.attach();
  const opening = f.post(f.config.gate, 'open', { path: 'scene.stl' });
  const initial = await nextCommand(f, opening);
  f.service.commandResult({ id: initial.id, ...firstBridge, result: { path: initial.path, revision: initial.revision, version: 1 } });
  assert.equal((await opening).body.autoRefresh, true);
  assert.equal(opened, 1);
  f.service.detach(firstBridge);
  assert.equal(closed, 1);
  const nextBridge = f.service.attach();
  const observing = f.post(f.config.gate, 'snapshot');
  const ready = await nextCommand(f, observing, value => value.operation === 'open' && value.bridgeId === nextBridge.bridgeId);
  f.service.commandResult({ id: ready.id, ...nextBridge, result: { path: ready.path, revision: ready.revision, version: 2 } });
  const capture = await nextCommand(f, observing, value => value.operation === 'snapshot' && value.bridgeId === nextBridge.bridgeId);
  f.service.commandResult({ id: capture.id, ...nextBridge, result: { path: capture.path, revision: capture.revision, version: 2,
    dataUrl: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg', width: 2, height: 2 } });
  assert.equal((await observing).status, 200);
  assert.equal(opened, 2, 'the new bridge needs a live watcher rather than a retained autoRefresh flag');
  assert.equal(ready.autoRefresh, true);
  events('change', 'material.png');
  await Promise.all([...queued.values()].map(callback => callback())); queued.clear();
  assert.equal(f.events.filter(event => event.topic === 'modelPreviewChanged').at(-1)?.value.bridgeId, nextBridge.bridgeId);
  f.service.close({ scope: f.config.scope });
  assert.equal(closed, 2);
});

test('a reconnect watcher failure reports unavailable refresh while keeping the new scene usable', { timeout: 5000 }, async t => {
  let watchers = 0;
  const f = await fixture(t, { watch() {
    if (++watchers > 1) throw new Error('watch unavailable after reconnect');
    return { on() {}, unref() {}, close() {} };
  } });
  const firstBridge = f.service.attach();
  const opening = f.post(f.config.gate, 'open', { path: 'scene.stl' });
  const initial = await nextCommand(f, opening);
  f.service.commandResult({ id: initial.id, ...firstBridge, result: { path: initial.path, revision: initial.revision, version: 1 } });
  await opening;
  f.service.detach(firstBridge);
  const nextBridge = f.service.attach();
  const observing = f.post(f.config.gate, 'view', { preset: 'front' });
  const ready = await nextCommand(f, observing, value => value.operation === 'open' && value.bridgeId === nextBridge.bridgeId);
  assert.equal(ready.autoRefresh, false);
  f.service.commandResult({ id: ready.id, ...nextBridge, result: { path: ready.path, revision: ready.revision, version: 2 } });
  const view = await nextCommand(f, observing, value => value.operation === 'view');
  f.service.commandResult({ id: view.id, ...nextBridge, result: { path: view.path, revision: view.revision, version: 2 } });
  assert.equal((await observing).status, 200);
  assert.equal(watchers, 2);
});

test('a renderer read race adopts newly observed file bytes before issuing another ready request', { timeout: 5000 }, async t => {
  const f = await fixture(t, controlledWatch().seam), bridge = f.service.attach();
  const opening = f.post(f.config.gate, 'open', { path: 'scene.stl' });
  const first = await nextCommand(f, opening);
  await writeFile(first.path, 'solid new bytes before render\nendsolid new bytes');
  f.service.commandResult({ id: first.id, ...bridge, error: 'model_preview_file_changed_before_render' });
  const fresh = await nextCommand(f, opening, command => command.id !== first.id);
  assert.notEqual(fresh.fileSignature, first.fileSignature);
  assert.notEqual(fresh.revision, first.revision);
  f.service.commandResult({ id: fresh.id, ...bridge, result: { path: fresh.path, revision: fresh.revision,
    fileSignature: fresh.fileSignature, version: 2 } });
  const result = await opening;
  assert.equal(result.status, 200);
  assert.equal(result.body.fileSignature, fresh.fileSignature);
  assert.equal(f.events.filter(event => event.topic === 'modelPreviewCommand').length, 2);
});

test('the same renderer read-race error with unchanged file bytes is returned without blind retry', { timeout: 5000 }, async t => {
  const f = await fixture(t, controlledWatch().seam), bridge = f.service.attach();
  const opening = f.post(f.config.gate, 'open', { path: 'scene.stl' });
  const first = await nextCommand(f, opening);
  f.service.commandResult({ id: first.id, ...bridge, error: 'model_preview_file_changed_before_render' });
  const result = await opening;
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'model_preview_file_changed_before_render');
  assert.equal(f.events.filter(event => event.topic === 'modelPreviewCommand').length, 1);
});

test('explicit renderer byte signatures and changed notifications preserve the current file identity', { timeout: 5000 }, async t => {
  const clock = controlledWatch(), f = await fixture(t, clock.seam), bridge = f.service.attach();
  const opening = f.post(f.config.gate, 'open', { path: 'scene.stl' });
  const first = await nextCommand(f, opening);
  f.service.commandResult({ id: first.id, ...bridge, result: { path: first.path, revision: first.revision,
    fileSignature: first.fileSignature, version: 1 } });
  await opening;
  clock.change('material.png'); await clock.flush();
  const changed = await f.when('modelPreviewChanged');
  assert.equal(changed.fileSignature, first.fileSignature);
  const viewing = f.post(f.config.gate, 'view', { preset: 'top' });
  const ready = await nextCommand(f, viewing, command => command.operation === 'open' && command.id !== first.id);
  assert.equal(f.service.commandResult({ id: ready.id, ...bridge, result: { path: ready.path, revision: ready.revision,
    fileSignature: '0'.repeat(64), version: 2 } }).ok, false);
  assert.match((await viewing).body.error, /stale_result/);
});

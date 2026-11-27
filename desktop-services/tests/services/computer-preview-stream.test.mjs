import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createComputerPreviewStream, computerPreviewScope, resolveComputerPreviewPython } from '../../src/tooling/computer-control/windows/computer-preview-stream.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const params = { projectRoot: process.cwd(), conversationId: 'one' };
const frame = seq => ({ type: 'frame', data: 'aGVsbG8=', mimeType: 'image/jpeg', width: 2560, height: 1600,
  originX: -2560, originY: 0, cursorX: -1280, cursorY: 200, timestamp: 1000, seq });

function fixture(options = {}) {
  const events = [];
  const children = [];
  const { emit: injectedEmit, ...overrides } = options;
  const bridge = createComputerPreviewStream({
    platform: 'win32', resolveExecutable: async () => 'python.exe',
    emit: (topic, payload) => { events.push({ topic, payload }); return injectedEmit?.(topic, payload); },
    spawnWorker: (executable, args, spawnOptions) => {
      const child = new EventEmitter();
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        exitCode: null, executable, args, spawnOptions, commands: [] });
      child.stdin.on('data', chunk => child.commands.push(chunk.toString()));
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
      child.message = message => child.stdout.write(`${JSON.stringify(message)}\n`);
      children.push(child);
      return child;
    },
    ...overrides,
  });
  return { bridge, events, children };
}

test('starts the resolved interpreter without MCP, streams physical frames only after a pull', async () => {
  const { bridge, events, children } = fixture();
  assert.equal((await bridge.start({ ...params, excludeWindow: 123 })).ok, true);
  const child = children[0];
  assert.equal(child.executable, 'python.exe');
  assert.deepEqual(child.args.slice(-2), ['0', '123']);
  assert.equal(child.spawnOptions.windowsHide, true);
  assert.equal(child.commands.length, 0);
  child.message({ type: 'status', state: 'running' });
  assert.deepEqual(child.commands, ['next\n']);
  child.message(frame(1));
  await tick();
  assert.equal(events.filter(e => e.topic === 'computerPreviewFrame').length, 1);
  const image = events.find(e => e.topic === 'computerPreviewFrame').payload;
  assert.equal(image.width, 2560);
  assert.equal(image.originX, -2560);
  assert.equal(image.scope, computerPreviewScope(params));
  assert.deepEqual(child.commands, ['next\n', 'next\n']);
  bridge.ack({ scope: image.scope, streamId: image.streamId, seq: image.seq });
  assert.deepEqual(child.commands, ['next\n', 'next\n']);
  bridge.stop(); child.kill();
});

test('transport backpressure pauses new capture and ignores unsolicited frames', async () => {
  let flush;
  const { bridge, events, children } = fixture({
    emit: topic => topic === 'computerPreviewFrame' ? new Promise(resolve => { flush = resolve; }) : undefined,
  });
  await bridge.start(params);
  const child = children[0];
  child.message({ type: 'status', state: 'running' });
  child.message(frame(1));
  child.message(frame(2));
  child.message({ type: 'status', state: 'running' });
  await tick();
  assert.equal(child.commands.length, 1);
  assert.equal(events.filter(e => e.topic === 'computerPreviewFrame').length, 1);
  bridge.ack({ scope: computerPreviewScope(params), streamId: events.at(-1).payload.streamId, seq: 1 });
  assert.equal(child.commands.length, 1);
  flush(); await tick();
  assert.equal(child.commands.length, 2);
  bridge.stop(); child.kill();
});

test('renderer acknowledgement is required and stale or future acknowledgements cannot release a frame', async () => {
  const { bridge, events, children } = fixture({ frameTimeoutMs: 25 });
  await bridge.start({ ...params, streamId: 'turn' });
  const child = children[0];
  child.message({ type: 'status', state: 'running' });
  child.message(frame(1));
  await tick();
  child.message(frame(2)); // Prefetch completes, but cannot be delivered yet.
  for (const wrong of [{ scope: 'wrong', streamId: 'turn', seq: 1 },
    { scope: computerPreviewScope(params), streamId: 'old', seq: 1 },
    { scope: computerPreviewScope(params), streamId: 'turn', seq: 2 }]) bridge.ack(wrong);
  assert.equal(child.commands.length, 2);
  assert.equal(events.filter(e => e.topic === 'computerPreviewFrame').length, 1);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(events.at(-1).payload.state, 'error');
  assert.match(events.at(-1).payload.detail, /画面确认/);
  child.kill();
});

test('same scope is idempotent, stale stops and old worker events cannot affect a new scope', async () => {
  const { bridge, events, children } = fixture();
  await bridge.start(params); await bridge.start(params);
  assert.equal(children.length, 1);
  const old = children[0];
  await bridge.start({ ...params, conversationId: 'two' });
  const active = children[1];
  bridge.stop({ scope: computerPreviewScope(params) });
  old.message({ type: 'status', state: 'running' }); old.message(frame(1)); old.kill();
  active.message({ type: 'status', state: 'running' }); active.message(frame(1));
  await tick();
  assert.equal(events.filter(e => e.topic === 'computerPreviewFrame').length, 1);
  assert.equal(events.at(-1).payload.scope, computerPreviewScope({ ...params, conversationId: 'two' }));
  bridge.dispose(); active.kill();
});

test('cancellation during interpreter resolution does not launch capture', async () => {
  let resolve;
  const { bridge, children } = fixture({ resolveExecutable: () => new Promise(r => { resolve = r; }) });
  const pending = bridge.start(params);
  bridge.stop(); resolve('python.exe');
  assert.equal((await pending).ok, false);
  assert.equal(children.length, 0);
});

test('stop resolves a pending startup immediately even when the resolver never settles', async () => {
  const { bridge, children } = fixture({ resolveExecutable: () => new Promise(() => {}) });
  const pending = bridge.start(params);
  bridge.stop();
  assert.deepEqual(await pending, { ok: false, error: '预览已取消' });
  assert.equal(children.length, 0);
});

test('resolver timeout bounds startup and a late resolver cannot replace a new stream', async () => {
  let resolveOld;
  let calls = 0;
  const { bridge, children, events } = fixture({ startupTimeoutMs: 15,
    resolveExecutable: () => ++calls === 1 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve('python.exe') });
  const expired = await bridge.start({ ...params, streamId: 'old' });
  assert.equal(expired.ok, false);
  assert.match(expired.error, /启动超时/);
  assert.equal(children.length, 0);
  assert.equal(events.at(-1).payload.streamId, 'old');
  await bridge.start({ ...params, streamId: 'new' });
  children[0].message({ type: 'status', state: 'running' });
  resolveOld('late-python.exe'); await tick();
  assert.equal(children.length, 1);
  assert.equal(events.at(-1).payload.streamId, 'new');
  bridge.stop(); children[0].kill();
});

test('package resolution and worker readiness share the same startup deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolvePython;
  const { bridge, children, events } = fixture({ startupTimeoutMs: 100,
    resolveExecutable: () => new Promise(resolve => { resolvePython = resolve; }) });
  const pending = bridge.start(params);
  t.mock.timers.tick(70);
  resolvePython('python.exe');
  assert.equal((await pending).ok, true);
  t.mock.timers.tick(29);
  assert.equal(events.at(-1).payload.state, 'starting');
  t.mock.timers.tick(1);
  assert.equal(events.at(-1).payload.state, 'error');
  assert.match(events.at(-1).payload.detail, /启动超时/);
  children[0].kill();
});

test('same conversation run epochs reject stale stop cleanup and stamp every event', async () => {
  const { bridge, events, children } = fixture();
  await bridge.start({ ...params, streamId: 'turn-1' });
  await bridge.start({ ...params, streamId: 'turn-2' });
  bridge.stop({ scope: computerPreviewScope(params), streamId: 'turn-1' });
  children[0].message({ type: 'status', state: 'running' });
  children[1].message({ type: 'status', state: 'running' });
  children[1].message(frame(1));
  await tick();
  assert.equal(events.at(-1).payload.streamId, 'turn-2');
  assert.equal(children[1].commands.includes('stop\n'), false);
  bridge.stop({ streamId: 'turn-2' });
  for (const child of children) child.kill();
});

test('startup timeout and frame timeout stop the worker and report a scoped error', async () => {
  for (const running of [false, true]) {
    const { bridge, events, children } = fixture({ startupTimeoutMs: 15, frameTimeoutMs: 15 });
    await bridge.start(params);
    if (running) children[0].message({ type: 'status', state: 'running' });
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(events.at(-1).payload.state, 'error');
    assert.match(events.at(-1).payload.detail, /超时/);
    assert.ok(children[0].commands.includes('stop\n'));
    bridge.dispose(); children[0].kill();
  }
});

test('malformed and oversized frames fail closed without emitting pixels', async () => {
  for (const bad of [null, { ...frame(1), width: 999999 }, { ...frame(1), data: 'not base64' }]) {
    const { bridge, events, children } = fixture();
    await bridge.start(params);
    children[0].message({ type: 'status', state: 'running' });
    children[0].message(bad);
    assert.equal(events.at(-1).payload.state, 'error');
    assert.equal(events.filter(e => e.topic === 'computerPreviewFrame').length, 0);
    bridge.stop(); children[0].kill();
  }
});

test('bad scope, unsupported platform and unavailable environment do not start capture', async () => {
  const invalid = fixture();
  assert.equal((await invalid.bridge.start({ ...params, conversationId: '' })).ok, false);
  assert.equal((await invalid.bridge.start({ ...params, display: -1 })).ok, false);
  assert.equal(invalid.children.length, 0);
  for (const options of [{ platform: 'linux' }, { resolveExecutable: async () => null }]) {
    const { bridge, children } = fixture(options);
    assert.equal((await bridge.start(params)).ok, false);
    assert.equal(children.length, 0);
  }
});

test('resolver asks the catalog and package manager; missing runtime never uses system Python', async () => {
  assert.equal(await resolveComputerPreviewPython({ catalog: { get: () => null }, packages: {} }), null);
  assert.equal(await resolveComputerPreviewPython({ catalog: { get: () => ({ id: 'windows-mcp' }) },
    packages: { resolve: async () => ({ executable: null }) } }), null);
});

test('prefetch overlaps acknowledgement but buffers only one frame and checks the delivered sequence', async () => {
  const { bridge, events, children } = fixture();
  await bridge.start({ ...params, streamId: 'pipeline' });
  const child = children[0];
  child.message({ type: 'status', state: 'running' });
  child.message({ ...frame(1), timestamp: Date.now() });
  await tick();
  assert.equal(child.commands.length, 2);
  child.message({ ...frame(2), timestamp: Date.now() });
  for (let seq = 3; seq <= 20; seq++) child.message(frame(seq));
  assert.equal(events.filter(e => e.topic === 'computerPreviewFrame').length, 1);
  assert.equal(child.commands.length, 2);
  const acknowledge = seq => bridge.ack({ scope: computerPreviewScope(params), streamId: 'pipeline', seq });
  acknowledge(2); // Not delivered yet.
  assert.equal(events.filter(e => e.topic === 'computerPreviewFrame').length, 1);
  acknowledge(1);
  assert.deepEqual(events.filter(e => e.topic === 'computerPreviewFrame').map(e => e.payload.seq), [1, 2]);
  await tick();
  assert.equal(child.commands.length, 3);
  child.message({ ...frame(3), timestamp: Date.now() });
  acknowledge(1); // Old acknowledgement cannot release the next delivery.
  assert.equal(events.filter(e => e.topic === 'computerPreviewFrame').length, 2);
  acknowledge(2);
  assert.deepEqual(events.filter(e => e.topic === 'computerPreviewFrame').map(e => e.payload.seq), [1, 2, 3]);
  bridge.stop(); child.kill();
});

test('a delayed viewer skips an aged prefetch and requests a fresh picture', async () => {
  const { bridge, events, children } = fixture();
  await bridge.start({ ...params, streamId: 'slow' });
  const child = children[0];
  child.message({ type: 'status', state: 'running' });
  child.message({ ...frame(1), timestamp: Date.now() });
  await tick();
  child.message({ ...frame(2), timestamp: Date.now() - 1000 });
  bridge.ack({ scope: computerPreviewScope(params), streamId: 'slow', seq: 1 });
  assert.equal(child.commands.length, 3);
  assert.deepEqual(events.filter(e => e.topic === 'computerPreviewFrame').map(e => e.payload.seq), [1]);
  child.message({ ...frame(3), timestamp: Date.now() });
  assert.deepEqual(events.filter(e => e.topic === 'computerPreviewFrame').map(e => e.payload.seq), [1, 3]);
  bridge.stop(); child.kill();
});

test('stop drops a prefetched frame and late flushes cannot restart capture', async () => {
  let flush;
  const { bridge, events, children } = fixture({ emit: topic => topic === 'computerPreviewFrame'
    ? new Promise(resolve => { flush = resolve; }) : undefined });
  await bridge.start({ ...params, streamId: 'old' });
  const old = children[0];
  old.message({ type: 'status', state: 'running' });
  old.message(frame(1));
  bridge.stop();
  const commands = old.commands.length;
  flush(); await tick();
  assert.equal(old.commands.length, commands);
  await bridge.start({ ...params, streamId: 'new' });
  children[1].message({ type: 'status', state: 'running' });
  old.message(frame(2));
  bridge.ack({ scope: computerPreviewScope(params), streamId: 'old', seq: 1 });
  assert.equal(events.filter(e => e.topic === 'computerPreviewFrame').length, 1);
  assert.equal(children[1].commands.length, 1);
  bridge.stop(); children.forEach(child => child.kill());
});

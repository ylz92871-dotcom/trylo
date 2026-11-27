import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createScreencastStream, MAX_SCREENCAST_DATA, SCREENCAST_DIMENSIONS } from '../../src/tooling/browser/screencast-stream.mjs';

function fixture(overrides = {}) {
  const commands = [], frames = [], acknowledgements = [], errors = [];
  const stream = createScreencastStream({
    send: async (method, params) => commands.push({ method, params }),
    emit: async (topic, frame) => frames.push({ topic, frame }),
    ack: id => acknowledgements.push(id), onError: message => errors.push(message), ...overrides,
  });
  const frame = (data, sessionId = 1) => ({ data, sessionId, metadata: { deviceWidth: 4096, deviceHeight: 3000, pageScaleFactor: 1 } });
  return { commands, frames, acknowledgements, errors, stream, frame };
}

it('starts lossless PNG and waits for the host write before acknowledging Chromium', async () => {
  let done;
  const f = fixture({ emit: () => new Promise(resolve => { done = resolve; }) });
  await f.stream.start();
  assert.deepEqual(f.commands[0], { method: 'Page.startScreencast', params: { ...SCREENCAST_DIMENSIONS, format: 'png' } });
  const delivery = f.stream.receive(f.frame('iVBOR-valid'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.acknowledgements, []);
  done();
  await delivery;
  assert.deepEqual(f.acknowledgements, [1]);
});

it('changes PNG to high quality JPEG when over transport budget, preserving dimensions', async () => {
  const f = fixture();
  await f.stream.start();
  await f.stream.receive(f.frame('iVBOR' + 'x'.repeat(MAX_SCREENCAST_DATA)));
  assert.equal(f.frames.length, 0);
  assert.deepEqual(f.commands.at(-1), { method: 'Page.startScreencast', params: { ...SCREENCAST_DIMENSIONS, format: 'jpeg', quality: 94 } });
  await f.stream.receive(f.frame('/9j/valid', 2));
  assert.equal(f.frames[0].frame.mimeType, 'image/jpeg');
  assert.equal(f.frames[0].frame.deviceWidth, 4096);
  assert.equal(f.frames[0].frame.deviceHeight, 3000);
  assert.deepEqual(f.acknowledgements, [1, 2]);
});

it('has bounded quality fallback and surfaces persistent oversized frames explicitly', async () => {
  const f = fixture();
  await f.stream.start();
  for (let index = 0; index < 6; index++) {
    await f.stream.receive(f.frame((index ? '/9j/' : 'iVBOR') + 'x'.repeat(MAX_SCREENCAST_DATA), index));
  }
  assert.deepEqual(f.commands.filter(command => command.params?.quality).map(command => command.params.quality), [94, 90, 85, 80, 75]);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /超过传输上限/);
  const count = f.commands.length;
  await f.stream.receive(f.frame('/9j/' + 'x'.repeat(MAX_SCREENCAST_DATA)));
  assert.equal(f.commands.length, count);
});

it('stop is synchronous and a delayed old transport write cannot ACK a new target', async () => {
  let done;
  const f = fixture({ emit: () => new Promise(resolve => { done = resolve; }) });
  const delivery = f.stream.receive(f.frame('iVBOR-valid'));
  await new Promise(resolve => setImmediate(resolve));
  f.stream.dispose();
  done();
  await delivery;
  assert.deepEqual(f.acknowledgements, []);
  await f.stream.receive(f.frame('iVBOR-new', 2));
  assert.deepEqual(f.acknowledgements, []);
});

it('discards queued frames from an earlier encoding after switching format', async () => {
  const f = fixture();
  const first = f.stream.receive(f.frame('iVBOR' + 'x'.repeat(MAX_SCREENCAST_DATA)));
  const old = f.stream.receive(f.frame('iVBOR-old', 2));
  await Promise.all([first, old]);
  assert.equal(f.frames.length, 0);
  assert.deepEqual(f.acknowledgements, [1]);
  await f.stream.receive(f.frame('/9j/new', 3));
  assert.equal(f.frames.length, 1);
  assert.equal(f.frames[0].frame.mimeType, 'image/jpeg');
});

it('reports host write failure without an unhandled rejection', async () => {
  const f = fixture({ emit: async () => { throw new Error('stdout closed'); } });
  await f.stream.receive(f.frame('iVBOR-valid'));
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /stdout closed/);
});

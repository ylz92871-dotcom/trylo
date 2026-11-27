import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeViewport, viewportRequest, viewportBounds } from '../../src/tooling/browser/native-browser-viewport.mjs';

function fixture() {
  const record = { activeLabel: 'one', zoom: 2, bounds: { x: 0, y: 0, width: 480, height: 600 } };
  let dimensions = { width: 240, height: 300 }, failures = 0;
  const calls = [];
  const owner = createNativeViewport({ record: () => record, target: () => ({ socket: 'owned' }),
    native: async (operation, params) => { calls.push({ operation, params }); if (operation === 'zoom') record.zoom = params.zoom; },
    cdp: async (_socket, method, params) => {
      if (method === 'Emulation.setDeviceMetricsOverride' || method === 'Emulation.clearDeviceMetricsOverride') {
        if (failures-- > 0) throw new Error('engine rejected metrics');
      }
      if (method === 'Emulation.setDeviceMetricsOverride') {
        dimensions = { width: params.width, height: params.height };
      }
      return { result: { value: dimensions } };
    } });
  return { owner, record, calls, fail: count => { failures = count; } };
}
test('fixed mode restores the existing page zoom on reset and on rejected metrics', async () => {
  const f = fixture();
  f.fail(1);
  await assert.rejects(f.owner.set('one', { mode: 'fixed', width: 1440, height: 900 }), /rejected metrics/);
  assert.equal(f.record.zoom, 2); assert.equal(f.owner.snapshot().mode, 'panel');
  await f.owner.set('one', { mode: 'fixed', width: 1440, height: 900 });
  assert.equal(f.record.zoom, 1);
  await f.owner.set('one', { mode: 'panel' });
  assert.equal(f.record.zoom, 2); assert.equal(f.owner.snapshot().width, 240);
  f.record.zoom = 3; await f.owner.sync('one');
  assert.equal(f.record.zoom, 3); assert.equal(f.owner.snapshot().width, 160);
});
test('failed rollback reports an error until the engine is successfully resynchronized', async () => {
  const f = fixture(); f.fail(2);
  await assert.rejects(f.owner.set('one', { mode: 'fixed', width: 1440, height: 900 }), /恢复均失败/);
  assert.match(f.owner.error(), /恢复均失败/);
  await f.owner.sync('one'); assert.equal(f.owner.error(), '');
});
test('dimension and display bounds validation rejects unsafe values without coercion', () => {
  for (const width of [0, -1, NaN, Infinity, 16385, '1440', 1.5]) assert.throws(() => viewportRequest({ mode: 'fixed', width, height: 900 }));
  assert.throws(() => viewportRequest({ mode: 'fixed', width: 16384, height: 16384 }));
  assert.throws(() => viewportBounds({ x: -1, y: 0, width: 480, height: 600 }));
  assert.deepEqual(viewportRequest({ mode: 'fixed', width: 390, height: 844, scale: 99, screenWidth: 999 }), { mode: 'fixed', width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
});

test('a renderer-applied resize updates page metrics without replaying stale native bounds', async () => {
  const f = fixture();
  await f.owner.layout({ x: 120, y: 100, width: 640, height: 600 }, true, true);
  assert.equal(f.calls.some(call => call.operation === 'layout'), false);
  assert.equal(f.owner.snapshot().width, 320);
});


test('follow-panel mode leaves live page dimensions to the native browser, rather than installing a delayed fixed viewport', async () => {
  const calls = [];
  const record = { activeLabel: 'one', zoom: 1, bounds: { x: 0, y: 0, width: 480, height: 600 } };
  let physical = { width: 480, height: 600 }, override;
  const owner = createNativeViewport({ record: () => record, target: () => ({ socket: 'one' }), native: async () => {},
    cdp: async (_socket, method, params) => {
      calls.push(method);
      if (method === 'Emulation.clearDeviceMetricsOverride') override = undefined;
      if (method === 'Emulation.setDeviceMetricsOverride') override = { width: params.width, height: params.height };
      return { result: { value: override ?? physical } };
    } });
  await owner.layout(record.bounds, true, true);
  assert.equal(calls.filter(method => method === 'Emulation.setDeviceMetricsOverride').length, 0);
  const count = calls.length;
  for (const width of [520, 640, 810]) {
    physical = { width, height: 600 };
    await owner.layout({ ...record.bounds, width }, true, true);
    assert.equal(owner.snapshot().width, width);
    assert.equal(override, undefined, 'a native resize must stay free to change innerWidth before a host measurement returns');
  }
  assert.equal(calls.length, count, 'dragging a panel must not enqueue page measurement or emulation writes');
});

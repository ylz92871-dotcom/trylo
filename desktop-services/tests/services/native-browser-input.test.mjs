import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeDisplayInput } from '../../src/tooling/browser/native-browser-input.mjs';
test('fixed display maps CSS mouse and touch positions without changing original cursor coordinates', () => {
  const viewport = { mode: 'fixed', scale: .25 };
  const mouse = { id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 200, y: 400, deltaY: 120, button: 'none' } };
  assert.deepEqual(nativeDisplayInput(mouse, viewport).params, { ...mouse.params, x: 50, y: 100 });
  assert.equal(mouse.params.x, 200);
  const touch = { method: 'Input.dispatchTouchEvent', params: { touchPoints: [{ x: 200, y: 400, radiusX: 4, radiusY: 8, id: 2 }] } };
  assert.deepEqual(nativeDisplayInput(touch, viewport).params.touchPoints, [{ x: 50, y: 100, radiusX: 1, radiusY: 2, id: 2 }]);
  assert.equal(nativeDisplayInput(mouse, { mode: 'panel', scale: 1 }), mouse);
  const keyboard = { method: 'Input.dispatchKeyEvent', params: { key: 'a' } };
  assert.equal(nativeDisplayInput(keyboard, viewport), keyboard);
});

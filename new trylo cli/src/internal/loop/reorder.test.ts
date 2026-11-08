import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_REORDER, createReorderBuffer } from "./reorder.js";

test("in-order producer sequences flush immediately", () => {
  const buffer = createReorderBuffer<string>();
  assert.deepEqual(buffer.push(0, "a"), { overflow: false, ready: ["a"] });
  assert.deepEqual(buffer.push(1, "b"), { overflow: false, ready: ["b"] });
});

test("bounded reordering releases when the gap fills", () => {
  const buffer = createReorderBuffer<string>(4);
  assert.deepEqual(buffer.push(1, "b"), { overflow: false, ready: [] });
  assert.deepEqual(buffer.push(0, "a"), { overflow: false, ready: ["a", "b"] });
});

test("duplicate older sequence is ignored", () => {
  const buffer = createReorderBuffer<string>();
  buffer.push(0, "a");
  assert.deepEqual(buffer.push(0, "again"), { overflow: false, ready: [] });
});

test("overflow fails closed when the gap exceeds the bound", () => {
  const buffer = createReorderBuffer<number>(2);

  buffer.push(1, 1);
  buffer.push(2, 2);
  const overflow = buffer.push(3, 3);

  assert.equal(overflow.overflow, true);
  assert.deepEqual(overflow.ready, []);
  assert.equal(MAX_REORDER, 16);
});

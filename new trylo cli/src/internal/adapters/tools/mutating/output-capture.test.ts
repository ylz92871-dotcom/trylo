import assert from "node:assert/strict";
import { test } from "node:test";
import { OutputCapture } from "./output-capture.js";

test("capture storage stays bounded across sustained output and preserves the ending", () => {
  const capture = new OutputCapture(4096);
  for (let i = 0; i < 2000; i += 1) {
    capture.write("中👍".repeat(200));
    assert.ok(capture.retainedBytes <= 4096);
  }
  capture.write("TAIL-ERROR");
  const result = capture.read(50);
  assert.match(result.text, /TAIL-ERROR/);
  assert.match(result.text, /bytes produced/);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 4096);
  assert.equal(capture.producedBytes, 2_800_010);
  assert.equal(Buffer.from(result.text).toString("utf8"), result.text);
});

test("small captures retain exact stream bytes and tiny capacities never overrun", () => {
  const capture = new OutputCapture(100);
  capture.write("first\n"); capture.write("中文\n");
  assert.deepEqual(capture.read(20), { text: "first\n中文\n", truncated: false });
  for (const capacity of [0, 1, 7, 32]) {
    const small = new OutputCapture(capacity);
    small.write("large".repeat(50));
    assert.ok(small.retainedBytes <= capacity);
    assert.ok(Buffer.byteLength(small.read(1).text) <= capacity);
  }
});

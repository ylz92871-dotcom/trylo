import assert from "node:assert/strict";
import { test } from "node:test";
import { isTranscriptItem } from "./transcript.js";

const reference = { path: "image.png", sha256: "a".repeat(64), bytes: 65, detail: "high" };
const result = { kind: "tool_result", sequence: 0, toolCallId: "image", name: "view_image", output: "Image summary.", truncated: false, outcome: "succeeded" };

test("old text-only transcript items and validated byte-free image references remain readable", () => {
  assert.equal(isTranscriptItem(result), true);
  assert.equal(isTranscriptItem({ ...result, images: [reference] }), true);
});

test("untrusted image metadata cannot become a persisted valid transcript item", () => {
  for (const bad of [null, {}, [null], [{ ...reference, bytes: 99999999 }], [{ ...reference, sha256: "bad" }],
    [{ ...reference, detail: "invalid" }], [{ ...reference, dataBase64: "undeclared" }]]) {
    assert.equal(isTranscriptItem({ ...result, images: bad }), false, JSON.stringify(bad));
  }
  assert.equal(isTranscriptItem({ ...result, outcome: "failed", images: [reference] }), false);
});

test("original tool arguments must pass the same JSON object guard as execution arguments", () => {
  const call = { kind: "tool_call", sequence: 0, toolCallId: "call", name: "echo", arguments: { value: 1 } };
  assert.equal(isTranscriptItem({ ...call, originalArguments: { arguments: { value: 1 } } }), true);
  for (const bad of [null, [], "invalid", { value: Number.NaN }]) {
    assert.equal(isTranscriptItem({ ...call, originalArguments: bad }), false);
  }
});

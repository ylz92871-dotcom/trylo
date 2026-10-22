import assert from "node:assert/strict";
import { test } from "node:test";
import { isStreamPartial } from "./stream-partial.js";
import { partialRecordPayload, readPartialRecord } from "./stream-partial-record.js";
import type { StreamPartial } from "./stream-partial.js";

test("V1 and V2 partials preserve Unicode and reject missing, reordered or altered prefixes", () => {
  const first: StreamPartial = { kind: "assistant_reasoning", blockId: "b", text: "甲😀", redacted: false };
  const next: StreamPartial = { ...first, text: first.text + "乙🙂" };
  const snapshot = partialRecordPayload(first)!;
  const delta = partialRecordPayload(next, first)!;
  assert.equal(snapshot.version, "1");
  assert.equal(delta.version, "2");
  assert.equal(isStreamPartial(delta), false, "old readers must refuse V2 instead of accepting only its suffix");
  assert.deepEqual(readPartialRecord(delta, readPartialRecord(snapshot)), { ...snapshot, text: next.text });
  for (const payload of [delta, { ...delta, offset: -1 }, { ...delta, offset: 4 },
    { ...delta, offset: 3.5 }, { ...delta, redacted: true }, { ...delta, version: "3" }]) {
    assert.equal(readPartialRecord(payload), undefined);
  }
  for (const payload of [{ ...delta, offset: 0 }, { ...delta, redacted: true }, { ...delta, text: "forged" }]) {
    assert.equal(readPartialRecord(payload, first), undefined);
  }
  assert.equal(partialRecordPayload(first, first), undefined);
});

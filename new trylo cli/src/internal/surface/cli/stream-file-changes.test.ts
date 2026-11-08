import assert from "node:assert/strict";
import { test } from "node:test";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import { projectEnvelopeSequence } from "./stream-projection.js";

function result(name: string, value: JsonObject) {
  const envelope: Envelope = { protocolVersion: "0.0", eventId: "e", sequence: 1,
    timestamp: "2026-10-17T00:00:00Z", kind: "tool_result", producerId: "test", producerSequence: 1,
    payload: { name, toolCallId: "c", status: "succeeded", output: "done", truncated: false, value } };
  return projectEnvelopeSequence([envelope])[0];
}

test("file result projection carries only mutation facts instead of dropping previews", () => {
  const frame = result("apply_patch", { applied: [{ op: "updated", path: "a.txt", preview: "@@\n-old\n+new\n" }], secret: "must not cross" });
  assert.ok(frame && "fileChanges" in frame);
  assert.deepEqual(frame.fileChanges, [{ kind: "patched", path: "a.txt", preview: "@@\n-old\n+new\n" }]);
  assert.equal(JSON.stringify(frame).includes("must not cross"), false);
});

test("overwrite metadata survives without inventing an Add-style diff", () => {
  const frame = result("apply_patch", { applied: [{ op: "added", mode: "overwritten", path: "a.txt", preview: "+only new contents" }] });
  assert.ok(frame && "fileChanges" in frame);
  assert.deepEqual(frame.fileChanges, [{ kind: "overwritten", path: "a.txt" }]);
});

test("singular mutations carry mode and the shared preview budget is bounded", () => {
  const single = result("write_file", { fileWrite: { kind: "file_write", path: "new.txt", mode: "created" } });

  assert.ok(single && "fileChanges" in single);
  assert.deepEqual(single.fileChanges, [{ path: "new.txt", kind: "created" }]);
  const batch = result("apply_patch", { applied: ["a.txt", "b.txt"].map(path => ({ op: "updated", path, preview: "+".repeat(40_000) })) });

  assert.ok(batch && "fileChanges" in batch);
  assert.equal(JSON.stringify(batch.fileChanges).includes('"truncated":true'), true);
  assert.ok(JSON.stringify(batch.fileChanges).length < 65_000);
  const other = result("web_fetch", { fileWrite: { kind: "file_write", path: "secret", mode: "created" }, preview: "secret" });

  assert.equal(other && "fileChanges" in other, false);
});

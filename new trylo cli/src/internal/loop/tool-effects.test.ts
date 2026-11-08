import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import { emitFileWriteRecord, readFileWriteRecords } from "./tool-effects.js";

/**
 * WP10.3: one patch, one fact per file. The singular `fileWrite` contract
 * keeps working byte for byte; the plural `fileWrites` shape adds one
 * journal fact per committed file, in patch order.
 */

function emitAll(value: JsonObject): JsonObject[] {
  const out: JsonObject[] = [];
  emitFileWriteRecord((_kind, payload) => {
    out.push(payload);
  }, "call-1", "apply_patch", value);
  return out;
}

test("a singular fileWrite still emits exactly one fact", () => {
  const value: JsonObject = { fileWrite: { kind: "file_write", path: "a.txt", bytes: 3, mode: "created" } };
  assert.equal(readFileWriteRecords("call-1", "write_file", value).length, 1);
  const emitted = emitAll(value);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.path, "a.txt");
  assert.equal(emitted[0]?.mode, "created");
});

test("a fileWrites batch emits one fact per file, in order", () => {
  const value: JsonObject = {
    fileWrites: [
      { kind: "file_write", path: "new.txt", bytes: 5, mode: "created" },
      { kind: "file_write", path: "keep.ts", bytes: 9, mode: "patched" },
      { kind: "file_write", path: "gone.txt", bytes: 0, mode: "deleted" },
      { kind: "file_write", path: "dst.txt", bytes: 4, mode: "moved" },
    ],
  };
  const records = readFileWriteRecords("call-1", "apply_patch", value);

  assert.deepEqual(
    records.map((record) => `${record.effect.mode}:${record.effect.path}`),
    ["created:new.txt", "patched:keep.ts", "deleted:gone.txt", "moved:dst.txt"],
  );
  assert.equal(emitAll(value).length, 4);
});

test("malformed entries are skipped, never emitted as facts", () => {
  const value: JsonObject = {
    fileWrites: [{ kind: "file_write", path: "ok.txt", bytes: 1, mode: "created" }, { kind: "nope" }, "junk"],
  };
  assert.equal(emitAll(value).length, 1);
});

test("no file-write shape means no facts, not an error", () => {
  assert.deepEqual(emitAll({ output: "nothing changed" }), []);
});

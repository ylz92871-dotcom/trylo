import assert from "node:assert/strict";
import { test } from "node:test";
import { createPartialRecorder } from "./partial-recorder.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { readPartialRecord } from "../../protocol/stream-partial-record.js";
import type { StreamPartial } from "../../protocol/stream-partial.js";

test("a failed suffix ack does not advance the durable prefix and closed blocks restart", async () => {
  const stored: JsonObject[] = [];
  let fail = false;
  const preserve = createPartialRecorder(async payload => {
    if (fail) { fail = false; return { ok: false, code: "disk_full" }; }
    stored.push(payload); return { ok: true };
  });
  const partial = (text: string): StreamPartial => ({ kind: "tool_input", blockId: "call", name: "write_file", text });
  assert.deepEqual(await preserve([partial("abc")]), { ok: true });
  fail = true;
  assert.deepEqual(await preserve([partial("abcdef")]), { ok: false, code: "disk_full" });
  assert.deepEqual(await preserve([partial("abcdefghi")]), { ok: true });
  assert.equal(stored[1]?.offset, 3);
  assert.equal(stored[1]?.textDelta, "defghi");
  const recovered = readPartialRecord(stored[1]!, readPartialRecord(stored[0]!));
  assert.equal(recovered?.text, "abcdefghi");
  await preserve([]);
  await preserve([partial("abcdefghi fresh")]);
  assert.equal(stored[2]?.version, "1", "a closed block does not lend its prefix to a new block");
});

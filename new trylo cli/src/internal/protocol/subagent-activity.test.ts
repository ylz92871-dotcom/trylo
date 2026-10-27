import assert from "node:assert/strict";
import { test } from "node:test";
import type { Envelope } from "./envelope.js";
import { isSubagentToolActivity, subagentToolActivity } from "./subagent-activity.js";

const envelope = (kind: string, payload: Envelope["payload"]): Envelope => ({
  protocolVersion: "0.0", eventId: "test", sequence: 1, producerId: "loop", producerSequence: 1,
  timestamp: "2026-10-25T00:00:00Z", kind, payload,
});

test("child tool facts exclude arguments, output and reasoning", () => {
  assert.deepEqual(subagentToolActivity(envelope("tool_use", { toolCallId: "t", name: "write_file", arguments: { secret: "private" } })),
    { id: "t", kind: "tool", tool: "write_file" });
  assert.deepEqual(subagentToolActivity(envelope("tool_result", { toolCallId: "t", name: "write_file", status: "failed", output: "private" })),
    { id: "t", kind: "result", tool: "write_file", ok: false });
  assert.equal(subagentToolActivity(envelope("thinking", { text: "private" })), undefined);
});

test("activity guards reject incomplete lifecycle facts", () => {
  for (const raw of [null, {}, { id: "t", kind: "tool" }, { id: "t", kind: "result", ok: "yes" }]) {
    assert.equal(isSubagentToolActivity(raw), false);
  }
  assert.equal(isSubagentToolActivity({ id: "t", kind: "result", ok: true }), true);
});

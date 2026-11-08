import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptItem } from "../protocol/transcript.js";
import { methodExecutionSpan, methodRequestBoundary, previousMethodExecutionSpan } from "./method-execution-span.js";

const call = (sequence: number, name = "read_file", id = "reused"): TranscriptItem =>
  ({ kind: "tool_call", sequence, toolCallId: id, name, arguments: {} });
const result = (sequence: number, name = "read_file", id = "reused", outcome: "succeeded" | "cancelled" = "succeeded"): TranscriptItem =>
  ({ kind: "tool_result", sequence, toolCallId: id, name, output: "", truncated: false, outcome });

test("fresh span follows canonical positional pairing for a legal repeated call id", () => {
  const history = [call(1), result(2), call(5), result(6)];
  assert.deepEqual(methodExecutionSpan(history), { firstSequence: 5, lastSequence: 6, toolNames: ["read_file"] });
  assert.equal(methodRequestBoundary(history), 6);
});

test("an extra result without a new call has no span", () => {
  assert.equal(methodExecutionSpan([call(1), result(2), result(3)]), undefined);
});

test("empty replies cannot turn an old result tail into fresh execution", () => {
  const history = [call(1), result(2)];
  const boundary = methodRequestBoundary(history)!;
  assert.ok(methodExecutionSpan(history)!.firstSequence <= boundary);
});

test("recovery finds business settlement across later input and control-only results", () => {
  const history: TranscriptItem[] = [call(1), result(2), { kind: "user", sequence: 3, text: "continue" },
    call(4, "method_context", "control"), result(5, "method_context", "control", "cancelled"),
    { kind: "assistant_text", sequence: 6, blockId: "b", text: "" }];
  assert.deepEqual(previousMethodExecutionSpan(history), { firstSequence: 1, lastSequence: 2, toolNames: ["read_file"] });
  assert.deepEqual(methodExecutionSpan(history.slice(0, 5))?.toolNames, ["method_context"]);
});

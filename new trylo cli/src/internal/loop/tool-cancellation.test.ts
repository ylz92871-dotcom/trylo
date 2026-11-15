import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ToolOutcome } from "../ports/tools.js";
import { executeWithCancellation } from "./tool-cancellation.js";

test("a settled tool result does not wait for an unresponsive cancellation receipt", async () => {
  const controller = new AbortController();
  let releaseResult = (_value: ToolOutcome): void => {};
  let releaseCancel = (): void => {};
  const result = new Promise<ToolOutcome>(resolve => { releaseResult = resolve; });
  const cancel = new Promise<void>(resolve => { releaseCancel = resolve; });
  const running = executeWithCancellation({ snapshot: () => [], async execute() { throw new Error("unused"); }, cancel: () => cancel },
    "tool", () => result, { signal: controller.signal, emit: () => {} });
  controller.abort();
  releaseResult({ outcome: "result", value: {}, output: "Actual execution ended.", truncated: false });
  try {
    const completed = await Promise.race([running.then(() => true), setImmediate().then(() => false)]);
    assert.equal(completed, true, "an actual terminal result is authoritative, not the Stop RPC receipt");
  } finally { releaseCancel(); await running; }
});

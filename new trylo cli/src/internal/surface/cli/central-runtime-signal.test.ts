import assert from "node:assert/strict";
import test from "node:test";
import { centralRuntimeResultSignal } from "./central-runtime-signal.js";
import { isCentralRuntimeWorkerReply } from "../../adapters/central-learning-runtime/worker-protocol.js";

test("a large original catalogue remains a valid bounded native continuation signal", () => {
  const sourceRefs = Array.from({ length: 80 }, (_, index) => `original-source:${index}`);
  const original = { state: "ready" as const, reason: "central_unconsumed_source_catalog_remaining", sourceRefs, wakeAt: 12345 };
  assert.equal(isCentralRuntimeWorkerReply({ operation: "result", requestId: "drive:actual", result: original }), false);
  const signal = centralRuntimeResultSignal(original);
  assert.equal(isCentralRuntimeWorkerReply({ operation: "result", requestId: "drive:actual", result: signal }), true);
  assert.equal(signal.state, original.state);assert.equal(signal.reason, original.reason);assert.equal(signal.wakeAt, original.wakeAt);
  assert.equal(sourceRefs.length, 80, "the original source catalogue is never truncated or rewritten");
});

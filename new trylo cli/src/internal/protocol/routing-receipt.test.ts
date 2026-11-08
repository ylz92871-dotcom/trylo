import assert from "node:assert/strict";
import test from "node:test";
import { isCliRoutingReceipt, projectRoutingReceipt } from "./routing-receipt.js";

test("routing wire projection retains candidates/version/actual cost and does not invent unknown usage", () => {
  const read = projectRoutingReceipt("read_file", { routing: { executionId: "read-1", candidateIds: ["whole", "stream"],
    decision: { path: "whole", reason: "learned_policy", versionId: "v1" }, actualPath: "stream", outcome: "completed",
    bytesRead: 100, latencyMs: 2, diagnostics: ["fallback"] } });

  assert.ok(read);
  assert.deepEqual(read.cost, { bytesRead: 100, latencyMs: 2 });
  assert.equal(read.actualPath, "stream");
  assert.equal(read.versionId, "v1");
  const spawned = projectRoutingReceipt("spawn_agent", { routing: { selectionExecutionId: "spawn-1", candidateIds: ["independent", "fork"],
    path: "fork", actualPath: "fork", reason: "learned_policy", versionId: "v2", diagnostics: [] } });

  assert.ok(spawned);
  assert.equal(spawned.cost, undefined);
  assert.equal(spawned.decisionPoint, "subagent.context.v1");
  assert.equal(projectRoutingReceipt("read_file", {}), undefined);
});

test("unknown wire versions, invalid candidates, forged permissions and nonfinite costs fail closed", () => {
  const receipt = { schemaVersion: 1, decisionPoint: "p", executionId: "e", candidateIds: ["a", "b"],
    selectedPath: "a", actualPath: "a", reason: "default", diagnostics: [] };

  assert.ok(isCliRoutingReceipt(receipt));

  for (const invalid of [{ ...receipt, schemaVersion: 2 }, { ...receipt, actualPath: "c" },
    { ...receipt, allowNetwork: true }, { ...receipt, cost: { tokens: Infinity } }, { ...receipt, candidateIds: ["a", "a"] }]) {
    assert.equal(isCliRoutingReceipt(invalid), false);
  }
});

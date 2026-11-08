import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowAccounting } from "./execution-accounting.js";
import { expectedRealTokens, realUsageEnvelopes } from "../testing/execution-accounting-real-fixture.js";
import { createWorkflowExecution } from "./execution.js";

test("real provider request usage snapshots equal the original terminal bill rather than counting each emission", () => {
  const accounting = createWorkflowAccounting();

  for (const envelope of realUsageEnvelopes) accounting.observe(envelope);

  assert.equal(accounting.snapshot().tokens, expectedRealTokens);
  assert.equal(accounting.snapshot().iterations, 16);
  assert.equal(accounting.snapshot().usageUncertain, false);
  const finalRequests = new Map<number, number>();
  let request = 0;

  for (const envelope of realUsageEnvelopes) {
    if (envelope.kind === "api_call") request += 1;
    if (envelope.kind === "usage") finalRequests.set(request, Number(envelope.payload.outputTokens));
  }

  assert.equal(accounting.snapshot().outputTokens, [...finalRequests.values()].reduce((sum, value) => sum + value, 0));
});

test("an unfinished request retains its observed lower bound without publishing a complete cost sample", () => {
  const run = createWorkflowExecution({ versionId: "wfl_test", traceId: "partial", artifact: { schemaVersion: 1, type: "workflow_learning",
    requestId: "r", scope: "project", taskFamily: { id: "report", intentClass: "report", checkKind: "acceptance" }, mode: "lessons_only",
    nodes: [], recovery: [], positiveEvidenceRefs: [], negativeEvidenceRefs: [], traces: [] } });

  run.observe(realUsageEnvelopes.find(event => event.kind === "api_call")!);
  const usage = realUsageEnvelopes.find(event => event.kind === "usage")!;

  run.observe({ ...usage, payload: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } });
  assert.equal(run.trace().cost, undefined);
  assert.equal(run.progress().tokens, 7);
  assert.equal(run.progress().usageUncertain, true);
});

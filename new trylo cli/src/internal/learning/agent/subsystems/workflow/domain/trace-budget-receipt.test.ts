import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowTrace } from "./trace-contracts.js";
import { learnWorkflow } from "./trace-learn.js";
import { parseWorkflowTrace } from "./trace-parse.js";

const task = { scope: "project:budget", taskFamily: { id: "reports", intentClass: "build", checkKind: "acceptance" as const } };

function trace(): WorkflowTrace {
  return { ...task, schemaVersion: 1, traceId: "budget", source: "imported", outcome: "success",
    steps: [{ nodeId: "build", input: "source", output: "report", dependsOn: [], check: "node verify.cjs", status: "passed", evidenceRefs: ["verify"] }],
    budgetReceipt: { initialTokens: 100, grantedTokens: 50, observedOutputTokens: 100, reservedUnknownTokens: 30, remainingTokens: 20, usageUncertain: true },
    cost: { tokens: 100, wallMs: 10 } };
}

test("budget receipts preserve real observations, host grants and uncertain reservations separately", () => {
  const original = trace();
  const parsed = parseWorkflowTrace(original);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.budgetReceipt, original.budgetReceipt);
});

test("budget receipts cannot manufacture remaining allowance", () => {
  const original = trace();
  assert.equal(parseWorkflowTrace({ ...original, budgetReceipt: { ...original.budgetReceipt, remainingTokens: 100 } }).ok, false);
});

test("partially observed usage does not count as a complete zero-cost measurement", () => {
  const learned = learnWorkflow({ ...task, requestId: "budget", subsystem: "workflow", collect: true,
    budget: { maxEpisodes: 4, maxSteps: 16, maxTokens: 8000 }, traces: [trace()] });
  assert.ok(learned.ok);
  assert.equal(learned.value.branches?.[0]?.statistics.measuredCostSamples, 0);
  assert.equal(learned.value.branches?.[0]?.statistics.totalTokens, 100);
});

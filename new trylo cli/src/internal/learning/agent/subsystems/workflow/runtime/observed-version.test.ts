import assert from "node:assert/strict";
import test from "node:test";
import { bindWorkflowProposal } from "./raw-facts.js";
import { workflowVersionForObservation } from "./observed-version.js";
import { learnWorkflow } from "../domain/trace-learn.js";
import type { WorkflowObservedTurn } from "./model-port.js";

test("saved interpretation reuse requires the complete actual recovery snapshot", () => {
  const task = { scope: "project", taskFamily: { id: "report", intentClass: "build-report", checkKind: "acceptance" as const } };
  const observed: WorkflowObservedTurn = { sessionId: "session", turnId: "turn", terminal: "completed", tokens: 20, wallMs: 40,
    checks: [{ toolCallId: "bad", command: "node check.cjs", status: "failed", evidenceRef: "failed-receipt", sequence: 2 },
      { toolCallId: "good", command: "node check.cjs", status: "passed", evidenceRef: "passed-receipt", sequence: 4 }],
    mutations: [{ toolCallId: "write", path: "report.json", evidenceRef: "write-receipt", sequence: 3 }] };
  const trace = bindWorkflowProposal(task, observed, { steps: [
    { nodeId: "build", input: "source", output: "report.json", dependsOn: [], checkToolCallId: "bad", recoveryTo: "build" },
    { nodeId: "build", input: "source", output: "report.json", dependsOn: [], checkToolCallId: "good" }] });

  assert.ok(trace.ok);
  const artifact = learnWorkflow({ ...task, requestId: "learned", subsystem: "workflow", collect: true,
    budget: { maxEpisodes: 4, maxSteps: 16, maxTokens: 10000 }, traces: [trace.value] });
  assert.ok(artifact.ok);
  const versions = [{ versionId: "saved", artifact: artifact.value }];

  assert.equal(workflowVersionForObservation(versions, task.scope, observed), "saved");
  assert.equal(workflowVersionForObservation(versions, "foreign", observed), undefined);

  for (const changed of [
    { ...observed, tokens: 21 }, { ...observed, terminal: "unknown" as const },
    { ...observed, checks: observed.checks.slice(1) },
    { ...observed, checks: observed.checks.map(item => ({ ...item, command: "node different-check.cjs" })) },
    { ...observed, mutations: [...observed.mutations, { ...observed.mutations[0]!, sequence: 5 }] },
  ]) assert.equal(workflowVersionForObservation(versions, task.scope, changed), undefined);
});

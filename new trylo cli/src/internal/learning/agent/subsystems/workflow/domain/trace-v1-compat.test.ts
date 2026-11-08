import assert from "node:assert/strict";
import test from "node:test";
import { learnWorkflowV1 } from "./trace-legacy.js";
import { parseWorkflowLearningArtifact } from "./trace-parse.js";

test("V1 assets replay their frozen derived graph while new learning uses V2", () => {
  const task = { scope: "project:legacy", taskFamily: { id: "legacy", intentClass: "build", checkKind: "acceptance" as const } };
  const result = learnWorkflowV1({ ...task, requestId: "old", subsystem: "workflow", collect: true,
    budget: { maxEpisodes: 2, maxSteps: 4, maxTokens: 4000 }, traces: [{ ...task, schemaVersion: 1, traceId: "legacy-success", source: "imported", outcome: "success",
      steps: [{ nodeId: "build", input: "source", output: "report", dependsOn: [], check: "node verify.cjs", status: "passed", evidenceRefs: ["old-check"] }] }] });

  assert.ok(result.ok);
  assert.equal(result.value.schemaVersion, 1);
  assert.equal(result.value.branches, undefined);
  const parsed = parseWorkflowLearningArtifact(result.value);

  assert.deepEqual(parsed, result);
});

import assert from "node:assert/strict";
import test from "node:test";
import { learnWorkflow } from "../domain/trace-learn.js";
import { familiesFromVersions } from "./known-families.js";

test("classification receives each branch's condition vocabulary without borrowing another workspace's premises", () => {
  const taskFamily = { id: "bundle", intentClass: "artifact_bundle", checkKind: "acceptance" as const };
  const traces = ["csv", "json"].map(format => ({ schemaVersion: 1 as const, traceId: `trace-${format}`, scope: "workspace-a", taskFamily,
    conditions: { input_format: format, output_schema: "bundle/v1" }, conditionEvidenceRefs: [`input-${format}`], source: "imported" as const,
    outcome: "success" as const, steps: [{ nodeId: "normalize", input: `source.${format}`, output: "out.json", dependsOn: [], check: "node check.cjs",
      status: "passed" as const, evidenceRefs: [`receipt-${format}`] }] }));
  const learned = learnWorkflow({ subsystem: "workflow", requestId: "nomination", scope: "workspace-a", taskFamily, collect: true,
    budget: { maxEpisodes: 8, maxSteps: 32, maxTokens: 8192, maxRounds: 8 }, traces });

  assert.ok(learned.ok);
  const contexts = familiesFromVersions([{ artifact: learned.value }, { artifact: learned.value }], "workspace-a");

  assert.equal(contexts.length, 2);
  assert.deepEqual(contexts.map(item => item.conditions?.input_format).sort(), ["csv", "json"]);
  assert(contexts.every(item => item.conditions?.output_schema === "bundle/v1"));
  assert.deepEqual(familiesFromVersions([{ artifact: learned.value }], "workspace-b"), []);
});

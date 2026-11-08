import assert from "node:assert/strict";
import test from "node:test";
import { orderToolReuseByContract, toolReuseExampleCoverage, type ToolReuseContractEvidence } from "./reuse-evidence.js";
import type { ToolEvolutionSample } from "./contracts.js";

test("known examples distinguish contract compatibility, disagreement and unknown input without asserting generalization", () => {
  const sample: ToolEvolutionSample = { sampleId: "one", role: "source", input: { value: 1 }, expected: { kind: "value", value: 2 } };

  assert.deepEqual(toolReuseExampleCoverage([sample], [
    { ref: "user:one", sample }, { ref: "user:correction", sample: { ...sample, expected: { kind: "value", value: 3 } } },
    { ref: "user:unseen", sample: { ...sample, input: { value: 4 } } }]), {
    matchingRefs: ["user:one"], conflictingRefs: ["user:correction"], uncoveredRefs: ["user:unseen"],
  });
  assert.deepEqual(toolReuseExampleCoverage([], [{ ref: "user:one", sample }]).uncoveredRefs, ["user:one"]);
});

test("a matching frozen task contract is offered before a lexically attractive conflicting tool, while an exact repair target stays visible", () => {
  const tools = [{ toolId: "best-name", versionId: "wrong" }, { toolId: "different-language", versionId: "fits" }, { toolId: "unknown" }];
  const row = (toolId: string, versionId: string, conflicting: boolean): ToolReuseContractEvidence => ({ toolId, versionId,
    implementationHash: "a".repeat(64), contractHash: "b".repeat(64), contractScope: { sourceCases: 2, heldOutCases: 2, generalization: "not_established" },
    taskExamples: { matchingRefs: conflicting ? [] : ["user:task"], conflictingRefs: conflicting ? ["user:task"] : [], uncoveredRefs: [] }, sameImplementationAs: [], taskAssessments: [] });
  const evidence = [row("best-name", "wrong", true), row("different-language", "fits", false)];

  assert.deepEqual(orderToolReuseByContract(tools, evidence).map(tool => tool.toolId), ["different-language", "unknown", "best-name"]);
  assert.equal(orderToolReuseByContract(tools, evidence, "wrong")[0]?.toolId, "best-name");
  assert.deepEqual(orderToolReuseByContract(tools, []), tools, "absence of conformance evidence must not manufacture a preference");
});

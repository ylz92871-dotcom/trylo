import assert from "node:assert/strict";
import test from "node:test";
import type { ToolEvolutionSample } from "./contracts.js";
import { freezeToolFreshContractCases, toolFreshContractCapacity, toolFreshContractCasesMatch } from "./contract-freshness.js";

const baseline: readonly ToolEvolutionSample[] = [
  { sampleId: "source-a", role: "source", input: 1, expected: { kind: "value", value: 2 } },
  { sampleId: "source-b", role: "source", input: 2, expected: { kind: "value", value: 4 } },
  { sampleId: "old-variation", role: "variation", input: 3, expected: { kind: "value", value: 6 } },
  { sampleId: "old-counterexample", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } },
];

test("old roles and renamed disclosed inputs cannot substitute for a current fresh pair", () => {
  const copied = freezeToolFreshContractCases({ baseline, samples: baseline, parentVersionId: "parent" });

  assert.ok(!copied.ok);
  assert.equal(copied.code, "npm_fresh_contract_required");
  const renamed = freezeToolFreshContractCases({ baseline, samples: baseline.map(sample => ({ ...sample, sampleId: `renamed-${sample.sampleId}` })) });

  assert.ok(!renamed.ok);
  assert.equal(renamed.code, "npm_fresh_contract_required");
  const samples: readonly ToolEvolutionSample[] = [...baseline,
    { sampleId: "current-variation", role: "variation", input: 2.5, expected: { kind: "value", value: 5 } },
    { sampleId: "current-counterexample", role: "counterexample", input: "bad", expected: { kind: "error", code: "invalid_input" } }];
  const current = freezeToolFreshContractCases({ baseline, samples, parentVersionId: "parent" });
  assert.ok(current.ok);
  assert.ok(toolFreshContractCasesMatch(current.freshCases, { baseline, samples, parentVersionId: "parent" }));
  assert.equal(toolFreshContractCasesMatch({ ...current.freshCases, variationSampleId: "old-variation" }, { baseline, samples, parentVersionId: "parent" }), false);
  assert.equal(toolFreshContractCasesMatch(current.freshCases, { baseline, samples, parentVersionId: "another-parent" }), false);
});

test("the existing sample cap is checked before design without deleting old regression cases", () => {
  const thirty: readonly ToolEvolutionSample[] = [...baseline, ...Array.from({ length: 26 }, (_, index) => ({ sampleId: `regression-${index}`,
    role: "variation" as const, input: index + 100, expected: { kind: "value" as const, value: index + 200 } }))];

  assert.deepEqual(toolFreshContractCapacity(thirty), { ok: true, minimumSamples: 32 });
  const overflow = toolFreshContractCapacity([...thirty, { sampleId: "one-more", role: "variation", input: 1000, expected: { kind: "value", value: 2000 } }]);

  assert.ok(!overflow.ok);
  assert.equal(overflow.code, "npm_fresh_contract_capacity");
  assert.equal(toolFreshContractCapacity(thirty.map(sample => ({ ...sample, role: "variation" }))).ok, false,
    "missing source examples also need capacity; relabeling disclosed samples is not allowed");
});

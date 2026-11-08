import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../../../../control/hash.js";
import type { ToolEvolutionSample } from "./contracts.js";
import { applyToolContractRevisions, contractRevisionReviewId, decodeToolContractRevisionProposal,
  decodeApprovedToolContractRevision, preserveOrReviseToolSamples, toolContractRevisionId,
  type ToolContractRevisionProposal } from "./contract-revision.js";

const samples: readonly ToolEvolutionSample[] = [
  { sampleId: "decimal", role: "source", input: 0.75, expected: { kind: "value", value: 2 } },
  { sampleId: "integer", role: "source", input: 3, expected: { kind: "value", value: 6 } },
  { sampleId: "zero", role: "variation", input: 0, expected: { kind: "value", value: 0 } },
  { sampleId: "bad", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } },
];

function proposal(): ToolContractRevisionProposal {
  return { type: "tool_contract_revision_proposal", schemaVersion: 1, parentVersionId: "parent", scope: "workspace",
    parentContractHash: contentHashOf(samples), reason: "incorrect_expectation", corrections: [{ sampleId: "decimal",
      oldSampleHash: contentHashOf(samples[0]), oldExpectedHash: contentHashOf(samples[0]!.expected), expected: { kind: "value", value: 1.5 },
      evidenceRefs: ["user:exact-decimal-correction"] }] };
}

function approved() {
  const draft = proposal(), revisionId = toolContractRevisionId(draft);
  const value = decodeApprovedToolContractRevision({ type: "tool_contract_revision_approved", schemaVersion: 1, revisionId, proposal: draft,
    approval: { grantId: "permission:consumed", action: "modify", candidateId: contractRevisionReviewId(draft), packageVersionId: draft.parentVersionId,
      scope: draft.scope, consumedAt: "2026-11-04T00:00:00.000Z", sequence: 1 } });
  assert.ok(value);
  return value;
}

test("an explicitly approved exact correction replaces the old oracle without losing other checks", () => {
  const revision = approved(), revised = samples.map(sample => sample.sampleId === "decimal" ? { ...sample, expected: { kind: "value" as const, value: 1.5 } } : sample);
  const result = preserveOrReviseToolSamples({ parentVersionId: "parent", scope: "workspace", parentSamples: samples, proposedSamples: revised, revisions: [revision] });
  assert.ok(result.ok);
  assert.equal(result.effectiveSamples[0]?.expected.kind, "value");
  assert.deepEqual(samples[0]?.expected, { kind: "value", value: 2 }, "history remains unchanged");
  assert.equal(preserveOrReviseToolSamples({ parentVersionId: "parent", scope: "workspace", parentSamples: samples, proposedSamples: revised, revisions: [] }).ok, false);
  assert.equal(preserveOrReviseToolSamples({ parentVersionId: "parent", scope: "workspace", parentSamples: samples, proposedSamples: revised.slice(0, 3), revisions: [revision] }).ok, false);
});

test("stale old bytes, changed role and conflicting corrections cannot repair an implementation by changing its tests", () => {
  const revision = approved();

  assert.equal(applyToolContractRevisions({ parentVersionId: "parent", scope: "other", parentSamples: samples, revisions: [revision] }).ok, false);
  assert.equal(applyToolContractRevisions({ parentVersionId: "parent", scope: "workspace", parentSamples: samples.slice(1), revisions: [revision] }).ok, false);
  const other = approved(), altered = { ...other, proposal: { ...other.proposal, corrections: [{ ...other.proposal.corrections[0]!, expected: { kind: "value" as const, value: 7 } }] } };
  const conflict = { ...altered, revisionId: toolContractRevisionId(altered.proposal), approval: { ...altered.approval, candidateId: contractRevisionReviewId(altered.proposal) } };

  assert.equal(applyToolContractRevisions({ parentVersionId: "parent", scope: "workspace", parentSamples: samples, revisions: [revision, conflict] }).ok, false);
  assert.equal(decodeToolContractRevisionProposal({ ...proposal(), corrections: [{ ...proposal().corrections[0], role: "variation" }] }), undefined);
  const applied = applyToolContractRevisions({ parentVersionId: "parent", scope: "workspace", parentSamples: samples, revisions: [revision] });
  assert.ok(applied.ok);
  const contradictory = [...applied.effectiveSamples, { sampleId: "duplicate-input", role: "variation" as const, input: 0.75, expected: { kind: "value" as const, value: 2 } }];

  assert.equal(preserveOrReviseToolSamples({ parentVersionId: "parent", scope: "workspace", parentSamples: samples, proposedSamples: contradictory, revisions: [revision] }).ok, false);
});

test("a model/verifier label or mismatched permission receipt cannot constitute user approval", () => {
  assert.equal(decodeToolContractRevisionProposal({ ...proposal(), approved: true, source: "verifier" }), undefined);
  const revision = approved();
  assert.equal(decodeApprovedToolContractRevision({ ...revision, approval: { ...revision.approval, action: "acquire" } }), undefined);
  assert.equal(decodeApprovedToolContractRevision({ ...revision, approval: { ...revision.approval, packageVersionId: "other" } }), undefined);
});

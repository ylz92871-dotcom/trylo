import assert from "node:assert/strict";
import { contentHashOf } from "../../../../control/hash.js";
import { npmTreeTestData } from "../adapters/acquisition/npm-install-test-support.js";
import { createNpmToolProductionPlan } from "../domain/evolution/npm-production-plan.js";
import { toolProductionVersion } from "../domain/evolution/production-plan.js";
import type { ToolEvolutionRequest, ToolEvolutionSample } from "../domain/evolution/contracts.js";
import type { NpmLearningContract, NpmLearningGrounding } from "../domain/evolution/npm-learning.js";
import type { NpmAdaptationInput } from "../runtime/npm-adaptation-types.js";
import type { npmContractBasis } from "../runtime/npm-contract-grounding.js";
import { contractRevisionReviewId, decodeApprovedToolContractRevision, toolContractRevisionId, type ToolContractRevisionProposal } from "../domain/evolution/contract-revision.js";

export type NpmContractDataBasis = Extract<Awaited<ReturnType<typeof npmContractBasis>>, { readonly ok: true }>;

/** TEST ONLY pure contract data; no model, installation or execution acceptance. */
export function npmContractDataFixture(count = 4) {
  const data = npmTreeTestData(), scope = data.plan.tree.scope;
  const evidence: ToolEvolutionSample[] = Array.from({ length: count }, (_, index) => index === count - 1
    ? { sampleId: `s${index}`, role: "counterexample", input: { invalid: true }, expected: { kind: "error", code: "invalid_input" } }
    : { sampleId: `s${index}`, role: index === count - 2 ? "variation" : "source", input: { value: index }, expected: { kind: "value", value: index } });
  const checks: ToolEvolutionRequest = { schemaVersion: 1, requestId: "TEST_ONLY_parent_checks", scope, capability: "TEST ONLY disclosed cases", operation: "create", evidence };
  const parent = createNpmToolProductionPlan({ workspaceId: "TEST_ONLY_workspace", installation: data.plan, checks,
    descriptor: { identity: "TEST_ONLY_grounding", description: "TEST ONLY", inputSchema: {}, mastery: { whenToUse: ["TEST ONLY disclosed regression cases"], preconditions: [], pitfalls: [] } },
    runtime: { profile: "confined_npm_library_v1", source: "module.exports=input=>input.value;" } });
  assert.ok(parent);
  const input: NpmAdaptationInput = { boardRoot: "TEST_ONLY_unused", workspaceId: parent.workspaceId, installation: data.plan, installationRoot: "TEST_ONLY_unused",
    plan: { type: "tool_learning_plan", schemaVersion: 1, scope, capability: checks.capability, createdAt: new Date(0).toISOString(),
      trigger: { action: "user_requested", runId: "TEST_ONLY", proposalKey: "TEST_ONLY", evidenceRefs: [] } },
    adaptation: "TEST ONLY preserve disclosed regression cases", admission: { jobId: `tool-adaptation_v1_${"a".repeat(64)}`, attempt: 1 },
    parent: { versionId: toolProductionVersion(parent), plan: parent, feedback: "TEST ONLY" },
    services: { allowance: async () => undefined, complete: async () => { assert.fail("grounding must fail before any model call"); } },
    signal: new AbortController().signal, now: () => 0 };
  const basis: NpmContractDataBasis = { ok: true, requirements: [{ ref: "requirement:TEST_ONLY", text: "TEST ONLY" }], approvedRevisions: [] };

  return { input, basis, parent, evidence };
}

export function npmObservedFacts(input: NpmAdaptationInput, samples: readonly ToolEvolutionSample[], reference = "observed:TEST_ONLY"): NpmAdaptationInput {
  return { ...input, plan: { ...input.plan, opportunity: { reportId: "TEST_ONLY", source: "user", executions: [],
    assessment: { kind: "opportunity", need: input.plan.capability, reason: "TEST ONLY actual case reference", toolCallIds: [], existingCapability: "insufficient" },
    grounding: { source: "observed_io", reference, samples } } } };
}

export function npmFrozenDataFixture(input: NpmAdaptationInput, grounding: NpmLearningGrounding): NpmLearningContract {
  assert.ok(input.parent);
  return { type: "tool_npm_learning_contract", schemaVersion: 1, subjectId: input.admission.jobId, installationId: input.parent.plan.origin.versionId,
    groundingHash: contentHashOf(grounding), checks: { ...input.parent.plan.checks, evidence: grounding.samples.map(row => row.sample) },
    origins: grounding.samples.map(row => ({ sampleId: row.sample.sampleId, kind: "contract" as const, ref: row.ref })),
    frozenBasis: { parentVersionId: input.parent.versionId, adaptationHash: contentHashOf(input.adaptation), grounding } };
}

/** TEST ONLY approved-record shape; full Permission consumption has separate owner tests. */
export function npmApprovedOracleData(fx: ReturnType<typeof npmContractDataFixture>) {
  const old = fx.evidence[0]!, expected = { kind: "value" as const, value: 999 };
  const proposal: ToolContractRevisionProposal = { type: "tool_contract_revision_proposal", schemaVersion: 1,
    parentVersionId: fx.input.parent!.versionId, parentContractHash: contentHashOf(fx.evidence), scope: fx.input.plan.scope, reason: "incorrect_expectation",
    corrections: [{ sampleId: old.sampleId, oldSampleHash: contentHashOf(old), oldExpectedHash: contentHashOf(old.expected), expected, evidenceRefs: ["user:TEST_ONLY_corrected_answer"] }] };
  const revisionId = toolContractRevisionId(proposal), approved = decodeApprovedToolContractRevision({ type: "tool_contract_revision_approved", schemaVersion: 1,
    revisionId, proposal, approval: { grantId: "TEST_ONLY_shape_no_permission_assertion", action: "modify", candidateId: contractRevisionReviewId(proposal),
      packageVersionId: proposal.parentVersionId, scope: proposal.scope, consumedAt: new Date(0).toISOString(), sequence: 1 } });
  assert.ok(approved);
  const basis: NpmContractDataBasis = { ...fx.basis, approvedRevisions: [approved] };

  return { basis, revisionId, expected };
}

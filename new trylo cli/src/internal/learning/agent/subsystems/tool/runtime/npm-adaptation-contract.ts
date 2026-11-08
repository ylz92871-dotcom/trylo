import { contentHashOf } from "../../../../control/hash.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { npmContractGrounded } from "../domain/evolution/npm-learning.js";
import { parseToolEvolutionRequest } from "../domain/evolution/parse.js";
import { npmContractPrompt } from "../domain/evolution/npm-learning-prompt.js";
import { recordOf, textOf } from "../domain/evolution/parse.js";
import { saveNpmLearningArtifact } from "./npm-adaptation-artifacts.js";
import { pipelineFailure } from "./pipeline-assets.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import { npmContractBasis, npmContractGrounding, npmFrozenGroundingDrift } from "./npm-contract-grounding.js";
import { fitNpmLearningResearchPrompt } from "../adapters/acquisition/npm-learning-research-budget.js";
import type { npmLearningSource } from "../adapters/acquisition/npm-learning-source.js";
import { mergeNpmLearningSource, npmLearningSourceFingerprint } from "../adapters/acquisition/npm-learning-source.js";
import type { NpmSourceRead } from "../domain/evolution/npm-learning.js";
import { researchNpmContract } from "./npm-contract-research.js";
import { canonicalNpmContractSnapshot, npmFrozenBasis, readNpmFrozenContract, reviseNpmFrozenContract } from "./npm-contract-freeze.js";
import { npmAdaptationParent } from "./npm-adaptation-parent.js";
import { npmMayReuseImplementation } from "./npm-baseline-candidate.js";
import { freezeToolFreshContractCases, toolFreshContractCapacity } from "../domain/evolution/contract-freshness.js";
import { canonicalNpmContractOrigins } from "./npm-contract-origins.js";

/** A restart loads the exact prior oracle instead of paying to silently invent another one. */
export async function prepareNpmLearningContract(input: NpmAdaptationInput, source: ReturnType<typeof npmLearningSource>,
  readSource: (request: NpmSourceRead) => ReturnType<typeof npmLearningSource>) {
  const installationId = npmInstallId(input.installation), subjectId = input.admission.jobId;
  const parent = npmAdaptationParent(input);
  const basis = await npmContractBasis(input);
  if (!basis.ok) return basis;

  const approvedRefs = basis.approvedRevisions.map(row => row.revisionId);
  if (approvedRefs.length > 8) return pipelineFailure("contract_revision_capacity", "Select a bounded, externally resolved correction set for this task");

  // Apply exact compatible approvals before comparing already-corrected task
  // facts. Raw checks still need their own explicit, canonical revision refs.
  const original = npmContractGrounding(input, basis, approvedRefs);
  if (!original.ok) return original;

  let grounding = original.grounding;
  const stored = await readNpmFrozenContract(input, basis, grounding);
  if (!stored.ok) return stored;

  const versionId = stored.versionId;
  let contract = stored.contract;
  if (contract === undefined) {
    if (grounding.requirements.length === 0 && grounding.samples.length === 0) return pipelineFailure("independent_requirement_required", "Task facts or a user/parent contract must ground adaptation");

    const capacity = toolFreshContractCapacity(grounding.samples.map(row => row.sample));
    if (!capacity.ok) return capacity;

    const allowance = await input.services.allowance();
    const reuseBaseline = npmMayReuseImplementation(input, basis.approvedRevisions.map(row => row.revisionId));
    if (allowance === undefined || allowance.callsRemaining < (reuseBaseline ? 1 : 2)) return pipelineFailure("learning_budget_exhausted", "Contract design and implementation require remaining central resources");

    const researched = await researchNpmContract(input, { contractId: versionId, initialSource: source,
      initialSourceFingerprint: contentHashOf(npmLearningSourceFingerprint(source)),
      prompt: (current, budget, researchBoundary) => fitNpmLearningResearchPrompt(current, input.researchReferences, (view, researchReferences) => npmContractPrompt({ subjectId, installationId, scope: input.plan.scope,
        capability: input.plan.capability, adaptation: input.adaptation, grounding, source: view, allowance: budget,
        ...(researchReferences === undefined ? {} : { researchReferences }),
        approvedRevisions: basis.approvedRevisions, researchBoundary, ...(parent === undefined ? {} : { feedback: parent.feedback }) }), budget.maxPromptChars),
      readSource: request => {
        const view = readSource(request);
        return { source: view, sourceFingerprint: contentHashOf(npmLearningSourceFingerprint(view)) };
      },
      mergeSource: mergeNpmLearningSource, reserveGenerationCall: !reuseBaseline });
    if (!researched.ok) return researched;

    const raw = researched.response;

    if (input.signal.aborted) return pipelineFailure("cancelled", subjectId);

    if (isNpmLearningDeferral(raw)) return saveNpmLearningDeferral(input, raw);

    if (!recordOf(raw)) return pipelineFailure("invalid_npm_learning_contract", "Expected a frozen check contract");

    const requested = parseToolEvolutionRequest(raw.checks);
    if (!requested.ok) return pipelineFailure("invalid_npm_learning_contract", "The proposed checks must satisfy the canonical request contract");

    const selected = npmContractGrounding(input, basis, requested.value.contractRevisionRefs);
    if (!selected.ok) return selected;

    grounding = selected.grounding;
    const origins = canonicalNpmContractOrigins(input, requested.value, grounding, raw.origins);
    if (!origins.ok) return origins;

    const fresh = freezeToolFreshContractCases({ baseline: grounding.samples.map(row => row.sample), samples: requested.value.evidence,
      ...(parent === undefined ? {} : { parentVersionId: parent.versionId }) });
    if (!fresh.ok) return fresh;

    const decoded = canonicalNpmContractSnapshot({ type: "tool_npm_learning_contract", schemaVersion: 1, subjectId, installationId,
      groundingHash: contentHashOf(grounding), checks: raw.checks, origins: origins.origins, frozenBasis: npmFrozenBasis(input, grounding), freshCases: fresh.freshCases });
    if (!decoded.ok) return decoded;

    contract = decoded.contract;

    if (contract.checks.scope !== input.plan.scope || contract.checks.capability !== input.plan.capability
      || !npmContractGrounded(contract, grounding)) return pipelineFailure("npm_contract_grounding_mismatch", "Expected answers must preserve the task and exact parent contract");

    const saved = await saveNpmLearningArtifact({ ...input, scope: input.plan.scope, versionId, content: contract, issuedAt: new Date(input.now()).toISOString() });
    if (!saved.ok) return saved;
  }

  if (contract.freshCases === undefined) return pipelineFailure("npm_fresh_contract_required",
    "The legacy frozen oracle remains readable but has no current parent-disjoint holdout commitment; use an explicit new contract task instead of silently regenerating it");

  const revised = await reviseNpmFrozenContract(input, basis, { contract, versionId });
  if (!revised.ok) return revised;

  const drift = npmFrozenGroundingDrift(input, basis, revised.contract);

  return drift.ok ? revised : drift;
}

export function isNpmLearningDeferral(raw: unknown): raw is { readonly action: "defer"; readonly reason: string; readonly neededEvidence: readonly string[] } {
  return recordOf(raw) && raw.action === "defer" && textOf(raw.reason, 2048) && Array.isArray(raw.neededEvidence)
    && raw.neededEvidence.length <= 16 && raw.neededEvidence.every(ref => textOf(ref, 512));
}

export async function saveNpmLearningDeferral(input: NpmAdaptationInput, raw: { readonly action: "defer"; readonly reason: string; readonly neededEvidence: readonly string[] }) {
  const content = { type: "tool_npm_learning_deferral", schemaVersion: 1, subjectId: input.admission.jobId, ...raw };
  const saved = await saveNpmLearningArtifact({ ...input, scope: input.plan.scope,
    versionId: `npm-deferral_v1_${contentHashOf(content)}`, content, issuedAt: new Date(input.now()).toISOString() });
  return saved.ok ? pipelineFailure("npm_adaptation_evidence_required", raw.reason) : saved;
}

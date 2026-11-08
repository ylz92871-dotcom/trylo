import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { decodeNpmToolProductionPlan, type NpmToolProductionPlan } from "../domain/evolution/npm-production-plan.js";
import { toolProductionScope, toolProductionVersion } from "../domain/evolution/production-plan.js";
import { decodeToolLearningPlan, decodeToolLearningResult, planVersionId, resultVersionId, toolLearningJobId } from "../domain/evolution/pipeline.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import { toolAcquisitionInstalledVersion, toolAcquisitionPlanVersion } from "../domain/evolution/acquisition-identity.js";
import { recordOf, textOf } from "../domain/evolution/parse.js";
import { assetAvailable } from "./pipeline-assets.js";
import { approvedToolContractRevisionRecords } from "./contract-revision-reader.js";
import { preserveOrReviseToolSamples } from "../domain/evolution/contract-revision.js";
import { generatedPredecessorFromBoard } from "./generated-predecessor.js";
import { hasImmutablePureProductionSourceProof } from "./immutable-production-source.js";

/** Pure Board evidence check. New bytes require a new acquisition; a parent reference is no grant. */
export function validNpmProductionLineage(state: BoardState, plan: NpmToolProductionPlan): boolean {
  let current = plan;
  const visited = new Set<string>();

  for (let depth = 0; depth < 256; depth++) {
    const decoded = decodeNpmToolProductionPlan(current);
    if (decoded === undefined || contentHashOf(decoded) !== contentHashOf(current)) return false;

    const evolution = current.evolution;

    // Original packages have no inheritance or correction authority to recheck.
    if (evolution === undefined) return (current.checks.contractRevisionRefs?.length ?? 0) === 0;

    if (visited.has(evolution.parentVersionId)) return false;

    visited.add(evolution.parentVersionId);
    const parent = state.assets.find(asset => asset.versionId === evolution.parentVersionId);
    const prior = parent === undefined ? undefined : decodeNpmToolProductionPlan(parent.content);
    if (prior === undefined) return validGeneratedReplacement(state, current);

    // An ancestor may be suspended or replaced: it remains immutable lineage, not current authority.
    if (parent?.kind !== "tool_package" || parent.schemaVersion !== 1 || prior === undefined
      || parent.contentHash !== contentHashOf(prior) || parent.contentHash !== evolution.parentContentHash
      || toolProductionVersion(prior) !== parent.versionId || parent.scope !== toolProductionScope(prior)
      || prior.workspaceId !== current.workspaceId || prior.origin.scope !== current.origin.scope || toolProductionScope(prior) !== toolProductionScope(current)) return false;

    const revisions = approvedToolContractRevisionRecords(state, evolution.parentVersionId, current.origin.scope, current.checks.contractRevisionRefs ?? []);
    if (!revisions.ok || !preserveOrReviseToolSamples({ parentVersionId: evolution.parentVersionId, scope: current.origin.scope,
      parentSamples: prior.checks.evidence, proposedSamples: current.checks.evidence, revisions: revisions.revisions }).ok) return false;

    const changed = npmInstallId(prior.installation) !== npmInstallId(current.installation);
    if (evolution.acquisition === undefined ? changed : !acquisitionMatches(state, current, evolution.acquisition)) return false;

    current = prior;
  }

  return false;
}

/** A different runtime can replace the implementation, while the exact old task contract survives. */
function validGeneratedReplacement(state: BoardState, plan: NpmToolProductionPlan): boolean {
  const evolution = plan.evolution;
  if (evolution?.acquisition === undefined) return false;

  const parent = generatedPredecessorFromBoard(state, evolution.parentVersionId, plan.workspaceId);
  if (parent === undefined || parent.contentHash !== evolution.parentContentHash || parent.scope !== plan.origin.scope
    || parent.capability !== plan.origin.capability || parent.descriptor.identity !== plan.candidate.identity) return false;

  const approved = approvedToolContractRevisionRecords(state, parent.versionId, parent.scope, plan.checks.contractRevisionRefs ?? []);

  return approved.ok && preserveOrReviseToolSamples({ parentVersionId: parent.versionId, scope: parent.scope,
    parentSamples: parent.checks.evidence, proposedSamples: plan.checks.evidence, revisions: approved.revisions }).ok
    && acquisitionMatches(state, plan, evolution.acquisition);
}

function acquisitionMatches(state: BoardState, plan: NpmToolProductionPlan,
  binding: { readonly jobId: string; readonly decisionVersionId: string }): boolean {
  const scope = plan.origin.scope;
  const original = state.jobs.find(job => job.jobId === binding.jobId);
  if (original?.domain !== "tool" || original.scope !== scope) return false;

  const learningPlan = decodeToolLearningPlan(workflow(state, planVersionId(binding.jobId), scope));
  if (learningPlan === undefined || learningPlan.scope !== scope || toolLearningJobId(learningPlan) !== binding.jobId) return false;

  if (learningPlan.targetVersionId !== plan.evolution?.parentVersionId) {
    // Legacy pure-production feedback kept its canonical source artifact as
    // target. Only its exact host-bound production source can strengthen this
    // replacement lineage; never choose the latest alias or a model claim.
    if (plan.evolution === undefined || !hasImmutablePureProductionSourceProof(state, learningPlan, plan.evolution.parentVersionId, plan.workspaceId)) return false;
  }

  const frozen = workflow(state, binding.decisionVersionId, scope);
  if (!recordOf(frozen) || frozen.type !== "tool_learning_decision" || frozen.schemaVersion !== 1
    || frozen.jobId !== binding.jobId || typeof frozen.attempt !== "number" || !Number.isSafeInteger(frozen.attempt)
    || frozen.attempt < 1 || frozen.attempt > original.attempt
    || (frozen.step !== undefined && (typeof frozen.step !== "number" || !Number.isSafeInteger(frozen.step) || frozen.step < 1))) return false;

  const result = decodeToolLearningResult(workflow(state, resultVersionId(binding.jobId, frozen.attempt), scope));
  if (result?.jobId !== binding.jobId || result.attempt !== frozen.attempt || result.decision?.action !== "acquire"
    || result.decisionVersionId !== binding.decisionVersionId || !["waiting_approval", "waiting_evidence"].includes(result.outcome)
    || contentHashOf(result.decision) !== contentHashOf(frozen.decision)
    || toolLearningDecisionVersionId({ jobId: binding.jobId, attempt: result.attempt, decision: result.decision,
      ...(frozen.step === undefined ? {} : { step: frozen.step }) }) !== binding.decisionVersionId) return false;

  const chosen = result.decision.candidate, root = plan.installation.tree.root;
  if (chosen.platform !== "npm" || chosen.id !== root.name || chosen.version !== root.version
    || !result.search.candidates.some(row => row.platform === chosen.platform && row.id === chosen.id && row.version === chosen.version)) return false;

  const acquisition = workflow(state, toolAcquisitionPlanVersion(binding.decisionVersionId), scope, "user_explicit");
  if (!recordOf(acquisition) || acquisition.type !== "tool_acquisition_plan" || acquisition.schemaVersion !== 1
    || acquisition.jobId !== binding.jobId || acquisition.decisionVersionId !== binding.decisionVersionId
    || contentHashOf(acquisition.plan) !== contentHashOf(plan.installation)) return false;

  const installationId = npmInstallId(plan.installation);
  const receipt = workflow(state, toolAcquisitionInstalledVersion(binding.decisionVersionId, installationId), scope, "user_explicit");

  return recordOf(receipt) && receipt.type === "tool_acquisition_installed" && receipt.schemaVersion === 1
    && receipt.jobId === binding.jobId && receipt.scope === scope && receipt.decisionVersionId === binding.decisionVersionId
    && receipt.installationId === installationId && textOf(receipt.grantId, 200);
}

function workflow(state: BoardState, versionId: string, scope: string, source?: "user_explicit") {
  const asset = state.assets.find(row => row.versionId === versionId);
  return asset?.kind === "workflow" && asset.scope === scope && (source === undefined || asset.source === source)
    && assetAvailable(state, asset) ? asset.content : undefined;
}

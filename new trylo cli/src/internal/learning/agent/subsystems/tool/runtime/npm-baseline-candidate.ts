import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import { createNpmToolProductionPlan } from "../domain/evolution/npm-production-plan.js";
import { preserveOrReviseToolSamples } from "../domain/evolution/contract-revision.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import { approvedToolContractRevisionRecords } from "./contract-revision-reader.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";
import { pipelineFailure } from "./pipeline-assets.js";

export type NpmBaselineStrategy = "clean_upstream" | "contract_correction";

/** An allowance hint only: actual source reuse still validates the selected
 * correction, exact parent and full frozen contract before running any case. */
export function npmMayReuseImplementation(input: NpmAdaptationInput, approvedRefs: readonly string[]): boolean {
  const parent = input.parent;
  if (parent === undefined || input.services.execute === undefined) return false;
  if (npmInstallId(parent.plan.installation) !== npmInstallId(input.installation)) {
    return parent.plan.installation.tree.root.name === input.installation.tree.root.name && input.acquisition !== undefined;
  }
  return approvedRefs.some(ref => !parent.plan.checks.contractRevisionRefs?.includes(ref));
}

export async function npmBaselineCandidate(input: NpmAdaptationInput, checks: ToolEvolutionRequest, contractId?: string) {
  const parent = input.parent;
  if (parent === undefined) return { kind: "not_applicable" as const };

  const sameInstall = npmInstallId(parent.plan.installation) === npmInstallId(input.installation);
  const refs = checks.contractRevisionRefs ?? [];
  const parentRefs = parent.plan.checks.contractRevisionRefs ?? [];
  if (sameInstall && (refs.length === 0 || contentHashOf([...refs].sort()) === contentHashOf([...parentRefs].sort()))) return { kind: "not_applicable" as const };

  if (!sameInstall && parent.plan.installation.tree.root.name !== input.installation.tree.root.name) return { kind: "not_applicable" as const };

  if (!sameInstall && input.acquisition === undefined) return pipelineFailure("upstream_acquisition_binding_required", "New upstream bytes require their exact acquisition evidence");

  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const exact = toolLearningParentFromBoard(loaded.state, parent.versionId);
  if (!exact.ok) return exact;

  if (exact.parent.kind !== "npm" || exact.parent.scope !== input.plan.scope || exact.parent.plan.workspaceId !== input.workspaceId
    || contentHashOf(exact.parent.plan) !== contentHashOf(parent.plan)) return pipelineFailure("baseline_parent_mismatch", parent.versionId);

  const revisions = approvedToolContractRevisionRecords(loaded.state, parent.versionId, input.plan.scope, refs);
  if (!revisions.ok) return revisions;

  if (sameInstall && revisions.revisions.length === 0) return { kind: "not_applicable" as const };

  const preserved = preserveOrReviseToolSamples({ parentVersionId: parent.versionId, scope: input.plan.scope,
    parentSamples: parent.plan.checks.evidence, proposedSamples: checks.evidence, revisions: revisions.revisions });
  if (!preserved.ok) return preserved;

  const strategy: NpmBaselineStrategy = sameInstall ? "contract_correction" : "clean_upstream";
  const candidate = createNpmToolProductionPlan({ workspaceId: input.workspaceId, installation: input.installation,
    descriptor: parent.plan.candidate, runtime: parent.plan.runtime, checks,
    ...(sameInstall && parent.plan.patches !== undefined ? { patches: parent.plan.patches } : {}),
    ...(contractId === undefined ? {} : { learning: { ...input.admission, contractId } }),
    evolution: { parentVersionId: parent.versionId, parentContentHash: contentHashOf(parent.plan),
      requestId: `${input.admission.jobId}:${input.admission.attempt}`, adaptation: input.adaptation,
      ...(input.acquisition === undefined ? {} : { acquisition: input.acquisition }) } });

  return candidate === undefined ? pipelineFailure(sameInstall ? "invalid_contract_correction_baseline" : "invalid_upstream_baseline", "The frozen contract must fit the original implementation")
    : { kind: "candidate" as const, candidate, strategy, parentVersionId: parent.versionId };
}

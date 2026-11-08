import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { npmInstallId, type NpmInstallPlan } from "../../../../../tooling/contract/npm-install.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { decodeToolResearchStep, toolGenerationResearchReference, type ToolNpmResearchReferences, type ToolResearchStep } from "../domain/evolution/research.js";
import { jsonBytes, recordOf } from "../domain/evolution/parse.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";

/** Candidate research remains a reference after acquisition. Matching a registry
 * claim is not proof that repository bytes built the installed archive. */
export function toolNpmResearchReferences(state: BoardState, plan: ToolLearningPlan, jobId: string, installation: NpmInstallPlan) {
  const root = installation.tree.root;

  if (installation.tree.scope !== plan.scope) return pipelineFailure("research_installation_scope_mismatch", "research and reviewed installation belong to different scopes");

  const reviewed = installation.tree.packages.find(item => item.location === root.location);
  if (reviewed === undefined) return pipelineFailure("research_installation_identity_missing", "the reviewed root archive is absent");

  const base: ToolNpmResearchReferences = { installationId: npmInstallId(installation), package: { name: root.name, version: root.version },
    implementationBasis: "reviewed_installation_files", repositoryTarballEquivalence: "not_established", observations: [] };
  let references = base;
  // A package API can help a different task. Its exact package identity, scope
  // and immutable archive are the reuse boundary, rather than capability text.
  const exact: { readonly step: ToolResearchStep; readonly versionId: string }[] = [];

  for (const asset of state.assets) {
    if (asset.kind !== "workflow" || asset.scope !== plan.scope || !assetAvailable(state, asset)
      || !recordOf(asset.content) || asset.content.type !== "tool_learning_research"
      || !recordOf(asset.content.inspection) || !recordOf(asset.content.inspection.candidate)) continue;

    const candidate = asset.content.inspection.candidate;
    if (candidate.platform !== "npm" || candidate.id !== root.name || candidate.version !== root.version) continue;

    const step = decodeToolResearchStep(asset.content);
    if (step === undefined || step.scope !== asset.scope
      || asset.versionId !== `tool-research_v1_${contentHashOf({ jobId: step.jobId, step: step.step, request: step.request })}`) {
      return pipelineFailure("invalid_research_asset", "An exact package reference failed its immutable research identity");
    }

    if (step.inspection?.status === "complete") exact.push({ step, versionId: asset.versionId });
  }

  // The current task's inspection wins bounded space over historical hints.
  exact.sort((left, right) => Number(left.step.jobId === jobId) - Number(right.step.jobId === jobId));

  for (const { step, versionId } of exact.slice(-4).reverse()) {
    const documents = step.inspection!.documents.map(document => toolGenerationResearchReference(document));
    const claims = documents.flatMap(document => document.basis?.kind === "registry_version_metadata" && document.basis.archiveClaim !== undefined
      ? [document.basis.archiveClaim] : []);
    const archiveClaimAlignment = claims.length === 0 ? "not_compared" : claims.some(claim => claim.archiveUrl !== reviewed.archiveUrl || claim.integrity !== reviewed.integrity)
      ? "conflicting_archive_claim" : "same_reviewed_archive_claim";
    const observation: ToolNpmResearchReferences["observations"][number] = { researchVersionId: versionId,
      origin: { jobId: step.jobId, capability: step.capability },
      occurredAt: step.occurredAt, archiveClaimAlignment, documents };
    const next = { ...references, observations: [observation, ...references.observations] };
    if (jsonBytes(next) <= 8_000) references = next;
  }

  return { ok: true as const, references };
}

/** Read-only adapter for the post-authorization construction composition. */
export async function readToolNpmResearchReferences(boardRoot: string, plan: ToolLearningPlan, jobId: string, installation: NpmInstallPlan) {
  const loaded = await createBoardReader(boardRoot).load();
  return loaded.ok ? toolNpmResearchReferences(loaded.state, plan, jobId, installation) : pipelineFailure(loaded.reason, loaded.detail);
}

import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { decodeNpmInstallPlan } from "../adapters/acquisition/npm-install-plan.js";
import { toolAcquisitionPlanVersion } from "../domain/evolution/acquisition-identity.js";
import { decodeToolAcquisitionFailure, toolAcquisitionFailureVersion, type ToolAcquisitionFailureEvidence } from "../domain/evolution/acquisition-failure.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { recordOf } from "../domain/evolution/parse.js";
import { toolAcquisitionDecisionFromBoard } from "./acquisition-decision.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";

/** Historical observations inform a later task; they never authorize another acquisition. */
export function toolAcquisitionFailureFromBoard(state: BoardState, ref: string, scope: string) {
  const asset = state.assets.find(row => row.versionId === ref), failure = asset === undefined ? undefined : decodeToolAcquisitionFailure(asset.content);
  if (asset === undefined || failure === undefined || asset.kind !== "workflow" || asset.source !== "inferred" || asset.scope !== scope || failure.scope !== scope
    || !assetAvailable(state, asset) || asset.contentHash !== contentHashOf(failure) || ref !== toolAcquisitionFailureVersion(failure)) {
    return pipelineFailure("invalid_acquisition_failure", "The acquisition observation is unavailable or failed its canonical archive binding");
  }

  const decision = toolAcquisitionDecisionFromBoard(state, failure.jobId, scope, failure.attempt);
  if (!decision.ok || decision.approvalId !== failure.decisionVersionId || decision.capability !== failure.capability
    || contentHashOf(decision.decision.candidate) !== contentHashOf(failure.candidate)) return pipelineFailure("acquisition_failure_binding_mismatch", ref);

  if (failure.installationId !== undefined) {
    const frozen = state.assets.find(row => row.versionId === toolAcquisitionPlanVersion(decision.approvalId));
    const plan = recordOf(frozen?.content) ? decodeNpmInstallPlan(frozen.content.plan) : undefined;
    if (frozen === undefined || !assetAvailable(state, frozen) || frozen.scope !== scope || !recordOf(frozen.content)
      || frozen.content.type !== "tool_acquisition_plan" || frozen.content.decisionVersionId !== decision.approvalId || plan === undefined
      || npmInstallId(plan) !== failure.installationId) return pipelineFailure("acquisition_failure_binding_mismatch", ref);
  }

  return { ok: true as const, failure: { ...failure, ref } satisfies ToolAcquisitionFailureEvidence, createdAt: asset.createdAt };
}

export function toolLearningAcquisitionFailures(state: BoardState, plan: { readonly scope: string; readonly capability?: string; readonly trigger: Pick<ToolLearningPlan["trigger"], "evidenceRefs"> },
  selection?: { readonly jobId: string; readonly attempt: number; readonly approvalId: string }) {
  const explicit = new Set(plan.trigger.evidenceRefs), failures: ToolAcquisitionFailureEvidence[] = [];
  if ([...explicit].filter(ref => ref.startsWith("tool-acquisition-failure_v1_")).length > 8) return pipelineFailure("acquisition_failure_context_limit", "A planning context can bind at most eight explicit acquisition observations");

  const assets = state.assets.filter(asset => asset.scope === plan.scope && asset.versionId.startsWith("tool-acquisition-failure_v1_")
    && (explicit.has(asset.versionId) || recordOf(asset.content) && (selection === undefined
      ? plan.capability !== undefined && asset.content.capability === plan.capability
      : asset.content.jobId === selection.jobId && asset.content.attempt === selection.attempt && asset.content.decisionVersionId === selection.approvalId)));
  if (assets.length > 768) return pipelineFailure("acquisition_failure_history_limit", "Acquisition history requires explicit archive maintenance");

  for (const ref of explicit) if (ref.startsWith("tool-acquisition-failure_v1_") && !assets.some(row => row.versionId === ref)) return pipelineFailure("acquisition_failure_not_found", ref);

  const ordered = [...assets].reverse().sort((a, b) => Number(explicit.has(b.versionId)) - Number(explicit.has(a.versionId)));

  for (const asset of ordered) {
    const read = toolAcquisitionFailureFromBoard(state, asset.versionId, plan.scope);
    if (!read.ok) {
      if (explicit.has(asset.versionId)) return read;
      continue;
    }
    if (selection !== undefined && (read.failure.jobId !== selection.jobId || read.failure.attempt !== selection.attempt || read.failure.decisionVersionId !== selection.approvalId)) continue;
    if (selection === undefined && !explicit.has(asset.versionId) && (plan.capability === undefined || read.failure.capability !== plan.capability)) continue;
    failures.push(read.failure);
    if (failures.length >= 8) break;
  }

  return { ok: true as const, failures };
}

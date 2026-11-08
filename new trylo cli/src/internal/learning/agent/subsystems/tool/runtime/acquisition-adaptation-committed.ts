import type { BoardState } from "../../../../control/state.js";
import { acquisitionAdaptationResultId } from "../domain/evolution/acquisition-identity.js";
import { recordOf, textOf } from "../domain/evolution/parse.js";
import { productionFromBoard } from "./production-assets.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";

export type AcquisitionAdaptationOutcome = { readonly ok: true; readonly versionId: string; readonly sourceChecked: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type AcquisitionCommittedBinding = { readonly originalJobId: string; readonly approvalId: string; readonly jobId: string;
  readonly attempt: number; readonly scope: string; readonly workspaceId: string; readonly installationId: string; readonly capability: string };

/** Shared automatic-recovery/operator reader. Corruption and withdrawal remain
 * typed diagnostics, never a model's assertion that a candidate was committed. */
export function acquisitionAdaptationOutcomeFromBoard(state: BoardState, input: AcquisitionCommittedBinding) {
  const versionId = acquisitionAdaptationResultId(input.jobId, input.attempt), asset = state.assets.find(row => row.versionId === versionId);
  if (asset === undefined) return { ok: true as const, outcome: undefined };

  const raw = asset.content, proposal = state.proposals.find(row => row.proposalId === asset.createdFromProposalId);
  if (asset.kind !== "workflow" || asset.scope !== input.scope || asset.source !== "inferred" || !assetAvailable(state, asset)
    || proposal?.proposalId !== `proposal:${versionId}` || proposal.domain !== "tool" || proposal.source !== "inferred" || proposal.candidateRef !== versionId
    || proposal.risk !== "low" || proposal.requiredVerifiers.length !== 0 || proposal.requestedAuthorities.length !== 0
    || !recordOf(raw) || raw.type !== "tool_acquisition_adaptation_result" || raw.schemaVersion !== 1 || raw.originalJobId !== input.originalJobId
    || raw.jobId !== input.jobId || raw.attempt !== input.attempt || raw.approvalId !== input.approvalId) return pipelineFailure("invalid_continuation_result", versionId);

  let outcome: AcquisitionAdaptationOutcome;

  if (raw.ok === true && typeof raw.versionId === "string" && typeof raw.sourceChecked === "boolean") {
    const selected = committedAcquisitionCandidateFromBoard(state, raw.versionId, input);
    if (!selected.ok) return selected;
    outcome = { ok: true, versionId: raw.versionId, sourceChecked: raw.sourceChecked };
  } else if (raw.ok === false && textOf(raw.code, 160) && textOf(raw.message, 4096)) outcome = { ok: false, code: raw.code, message: raw.message };
  else return pipelineFailure("invalid_continuation_result", versionId);

  return { ok: true as const, outcome };
}

export function committedAcquisitionCandidateFromBoard(state: BoardState, versionId: string, input: AcquisitionCommittedBinding) {
  const selected = productionFromBoard(state, versionId, input.workspaceId);
  if (!selected.ok) return pipelineFailure("invalid_continuation_candidate", versionId);

  const plan = selected.plan;
  if (plan.type !== "npm_tool_production_package" || plan.origin.scope !== input.scope || plan.origin.versionId !== input.installationId
    || plan.origin.capability !== input.capability || plan.learning?.jobId !== input.jobId || plan.learning.attempt !== input.attempt) {
    return pipelineFailure("invalid_continuation_candidate", versionId);
  }

  return { ok: true as const, versionId };
}

export function findCommittedAcquisitionCandidate(state: BoardState, input: AcquisitionCommittedBinding) {
  const candidates = state.assets.filter(asset => recordOf(asset.content) && asset.content.type === "npm_tool_production_package"
    && recordOf(asset.content.learning) && asset.content.learning.jobId === input.jobId && asset.content.learning.attempt === input.attempt);
  if (candidates.length > 1) return pipelineFailure("adaptation_recovery_ambiguous", input.jobId);
  return candidates.length === 0 ? { ok: true as const, versionId: undefined }
    : committedAcquisitionCandidateFromBoard(state, candidates[0]!.versionId, input);
}

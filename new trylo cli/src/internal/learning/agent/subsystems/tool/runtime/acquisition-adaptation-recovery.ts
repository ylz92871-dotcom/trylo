import type { BoardStore } from "../../../../control/store-port.js";
import type { BoardState } from "../../../../control/state.js";
import type { LearningJob } from "../../../../control/contracts.js";
import { pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { acquisitionAdaptationOutcomeFromBoard, findCommittedAcquisitionCandidate, type AcquisitionAdaptationOutcome } from "./acquisition-adaptation-committed.js";
import { acquisitionAdaptationResultId } from "../domain/evolution/acquisition-identity.js";

export { acquisitionAdaptationResultId } from "../domain/evolution/acquisition-identity.js";

type Input = { readonly job: LearningJob; readonly originalJobId: string; readonly approvalId: string; readonly scope: string;
  readonly workspaceId: string; readonly installationId: string; readonly capability: string; readonly issuedAt: string };

/** Recovery uses committed Board candidates/results. A running model call with
 * no committed outcome remains unknown and is never silently replayed. */
export async function recoverAcquisitionAdaptation(store: BoardStore, state: BoardState, input: Input) {
  const resultId = acquisitionAdaptationResultId(input.job.jobId, input.job.attempt);
  const binding = { ...input, jobId: input.job.jobId, attempt: input.job.attempt };
  const stored = acquisitionAdaptationOutcomeFromBoard(state, binding);
  if (!stored.ok) return stored;

  let outcome: AcquisitionAdaptationOutcome | undefined = stored.outcome;
  if (outcome === undefined && input.job.state === "running") {
    const candidate = findCommittedAcquisitionCandidate(state, binding);
    if (!candidate.ok) return candidate;
    if (candidate.versionId === undefined) return { ok: true as const, recovered: false as const };
    outcome = { ok: true, versionId: candidate.versionId, sourceChecked: false };
  } else if (outcome === undefined) return pipelineFailure("invalid_continuation_result", input.job.jobId);

  if (stored.outcome === undefined) {
    const saved = await savePipelineAsset(store, { versionId: resultId, kind: "workflow", scope: input.scope, source: "inferred", issuedAt: input.issuedAt,
      content: { type: "tool_acquisition_adaptation_result", schemaVersion: 1, originalJobId: input.originalJobId,
        jobId: input.job.jobId, attempt: input.job.attempt, approvalId: input.approvalId, ...outcome,
        recoveredFrom: "committed_production_candidate" } });
    if (!saved.ok) return saved;
  }

  if (input.job.state === "running") {
    const applied = await store.apply({ type: "complete_job", commandId: `${input.job.jobId}:terminal:${input.job.attempt}`,
      issuedAt: input.issuedAt, jobId: input.job.jobId, next: outcome.ok ? "waiting_approval" : "waiting_evidence" });
    if (!applied.ok) return pipelineFailure(applied.reason, applied.detail);
  }

  return outcome.ok ? { ...outcome, completed: true as const, continuationJobId: input.job.jobId, recovered: true as const } : outcome;
}

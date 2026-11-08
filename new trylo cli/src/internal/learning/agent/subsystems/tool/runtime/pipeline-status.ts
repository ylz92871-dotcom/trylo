import { readToolLearningPipeline } from "./pipeline-queue.js";
import { pipelineFailure } from "./pipeline-assets.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { toolAcquisitionFromBoard } from "./acquisition-continuation.js";
import { projectToolAcquisitionReview } from "./acquisition-review.js";

/** Versioned, bounded projection for Desktop; contains no recipe inputs or expected answers. */
export async function readToolLearningStatus(boardRoot: string, workspaceId: string) {
  const loaded = await readToolLearningPipeline(boardRoot);
  if (!loaded.ok) return loaded;

  const board = await createBoardReader(boardRoot).load();
  if (!board.ok) return pipelineFailure(board.reason, board.detail);

  const scoped = loaded.jobs.filter(job => job.scope === workspaceId);
  if (scoped.some(job => job.plan === undefined)) return pipelineFailure("pipeline_asset_invalid", "a workspace job has no valid immutable plan");

  const jobs = scoped.slice(-50).reverse().map(job => {
    const request = job.result?.decision?.action === "acquire" ? toolAcquisitionFromBoard(board.state, job.jobId, workspaceId) : undefined;
    const review = request?.ok ? projectToolAcquisitionReview(board.state, request) : undefined;
    const acquisition = review?.ok ? { approvalId: review.approvalId,
      ...(review.failure === undefined ? {} : { failure: review.failure }),
      ...(review.installation === undefined ? {} : { installationId: review.installation.installationId, installed: review.installation.installed }),
      ...(review.continuation === undefined ? {} : { continuation: review.continuation }) } : undefined;

    return { jobId: job.jobId, state: job.state, attempt: job.attempt,
    capability: job.plan?.capability ?? "", createdAt: job.plan?.createdAt ?? "", action: job.plan?.trigger.action ?? "",
    ...(job.result === undefined ? {} : { outcomeCode: job.result.code, searchStatus: job.result.search.status,
      ...(job.result.cleanupCode === undefined ? {} : { cleanupCode: job.result.cleanupCode }),
      ...(job.state === "waiting_evidence" && job.result.inputFingerprint !== undefined && job.result.inputFingerprintPolicy === undefined
        ? { legacyFingerprintManualResume: true as const } : {}),
      discovered: job.result.search.candidates.length,
      ...(job.result.candidateVersionId === undefined ? {} : { candidateVersionId: job.result.candidateVersionId }),
      ...(job.result.contractProposalId === undefined ? {} : { contractProposalId: job.result.contractProposalId }) }),
    ...(job.state !== "running" ? {} : { recovery: "needs_inspection" as const }),
    ...(acquisition === undefined ? {} : { acquisition,
      ...(acquisition.continuation?.versionId === undefined ? {} : { candidateVersionId: acquisition.continuation.versionId }) }),
  }; });

  return { ok: true as const, formatVersion: 1 as const, workspaceId, jobs, totalJobs: scoped.length, truncated: scoped.length > jobs.length };
}

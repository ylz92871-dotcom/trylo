import { shortId } from "../../learning/domains/shared/hash.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import { applySkillCommand, loadSkillBoard, skillCandidateScope } from "./board.js";
import type { SkillCandidate, SkillOpportunity } from "./runtime-contract.js";

export function skillTrialJobId(versionId: string, opportunity: SkillOpportunity): string {
  return shortId("skill-trial", [versionId, opportunity.opportunityId, opportunity.trialRevision ?? ""]);
}

/** Existing Board jobs own trial checkpoints; no parallel asset or retry ledger. */
export async function startSkillTrialJob(board: BoardStore, candidate: SkillCandidate, opportunity: SkillOpportunity, issuedAt: string): Promise<
  { readonly kind: "ready"; readonly jobId: string } | { readonly kind: "waiting"; readonly reason: string }> {
  const jobId = skillTrialJobId(candidate.versionId, opportunity);
  const state = await loadSkillBoard(board);
  const job = state.jobs.find(item => item.jobId === jobId);
  if (job?.state === "waiting_evidence" || job?.state === "succeeded" || job?.state === "failed") {
    return { kind: "waiting", reason: "trial_waiting_new_opportunity" };
  }

  if (job === undefined) await applySkillCommand(board, { type: "enqueue_job", issuedAt, commandId: `${jobId}:enqueue`, job: {
    jobId, observationId: opportunity.opportunityId, domain: "skill", scope: skillCandidateScope(candidate),
    maxAttempts: 1, dedupeKey: jobId,
  } });

  if (job?.state !== "running") await applySkillCommand(board, { type: "start_job", issuedAt, commandId: `${jobId}:start`, jobId });

  return { kind: "ready", jobId };
}

export async function completeSkillTrialJob(board: BoardStore, jobId: string, outcome: "waiting_evidence" | "succeeded", issuedAt: string): Promise<void> {
  await applySkillCommand(board, { type: "complete_job", issuedAt, commandId: `${jobId}:${outcome}`, jobId, next: outcome });
}

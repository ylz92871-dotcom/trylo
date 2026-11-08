import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { toolContractRevisionId } from "../domain/evolution/contract-revision.js";
import { approvedToolContractRevisionRecords } from "./contract-revision-reader.js";
import { contractRevisionReviewFromBoard } from "./contract-revisions.js";
import { pipelineFailure } from "./pipeline-assets.js";
import { planForJob, resultForJob } from "./pipeline-queue.js";

/** A read-only wakeup selection. The original worker still claims its job,
 * reserves from its original allowance and observes the execution permissions. */
export async function contractRevisionResumeJobs(boardRoot: string, proposalId: string, scope: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const review = contractRevisionReviewFromBoard(loaded.state, proposalId, scope);
  if (!review.ok) return review;

  const approved = approvedToolContractRevisionRecords(loaded.state, review.proposal.parentVersionId, scope,
    [toolContractRevisionId(review.proposal)]);
  if (!approved.ok) return approved;

  const jobIds: string[] = [];

  for (const job of loaded.state.jobs) {
    if (job.domain !== "tool" || job.scope !== scope || job.state !== "waiting_evidence") continue;
    const plan = planForJob(loaded.state, job.jobId), result = resultForJob(loaded.state, job.jobId, job.attempt);
    if (plan?.scope !== scope || result === undefined || (result.code !== "contract_revision_approval_required"
      && result.previousCode !== "contract_revision_approval_required") || result.contractProposalId !== proposalId) continue;
    jobIds.push(job.jobId);
    if (jobIds.length === 16) break;
  }

  return { ok: true as const, jobIds };
}

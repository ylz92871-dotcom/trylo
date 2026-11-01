import { readToolLearningPipeline } from "./pipeline-queue.js";
import { pipelineFailure } from "./pipeline-assets.js";

/** Versioned, bounded projection for Desktop; contains no recipe inputs or expected answers. */
export async function readToolLearningStatus(boardRoot: string, workspaceId: string) {
  const loaded = await readToolLearningPipeline(boardRoot);
  if (!loaded.ok) return loaded;
  const scoped = loaded.jobs.filter(job => job.scope === workspaceId);
  if (scoped.some(job => job.plan === undefined)) return pipelineFailure("pipeline_asset_invalid", "a workspace job has no valid immutable plan");
  const jobs = scoped.slice(-50).reverse().map(job => ({ jobId: job.jobId, state: job.state, attempt: job.attempt,
    capability: job.plan?.capability ?? "", createdAt: job.plan?.createdAt ?? "", action: job.plan?.trigger.action ?? "",
    ...(job.result === undefined ? {} : { outcomeCode: job.result.code, searchStatus: job.result.search.status,
      discovered: job.result.search.candidates.length,
      ...(job.result.candidateVersionId === undefined ? {} : { candidateVersionId: job.result.candidateVersionId }) }),
    ...(job.state !== "running" ? {} : { recovery: "needs_inspection" as const }),
  }));
  return { ok: true as const, formatVersion: 1 as const, workspaceId, jobs, totalJobs: scoped.length, truncated: scoped.length > jobs.length };
}

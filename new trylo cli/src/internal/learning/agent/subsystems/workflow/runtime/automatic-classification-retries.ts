import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { WorkflowLearningResult, WorkflowTask } from "../domain/trace-contracts.js";
import { workflowFailure } from "../domain/trace-parse.js";
import { workflowJobPremises, type WorkflowAutomaticInput, type WorkflowJobUsage } from "./automatic-job-contracts.js";
import { workflowLearningJobFromState, type WorkflowLearningJobView } from "./automatic-jobs.js";

type PaidClassification = { readonly task: WorkflowTask; readonly usage: WorkflowJobUsage; readonly jobId: string };

/** Only an explicitly funded retry lineage can supersede an immutable failed classification. */
export async function readSuccessfulWorkflowClassificationRetry(options: {
  readonly boardRoot: string; readonly input: WorkflowAutomaticInput & { readonly purpose: "classify" };
}): Promise<WorkflowLearningResult<PaidClassification | null>> {
  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

  const views = new Map<string, WorkflowLearningResult<WorkflowLearningJobView>>();
  const view = (id: string) => {
    const current = views.get(id) ?? workflowLearningJobFromState(loaded.state, id);
    views.set(id, current);
    return current;
  };
  const base = view(options.input.jobId);
  if (!base.ok) return base.code === "job_not_found" ? { ok: true, value: null } : base;

  const premises = contentHashOf(workflowJobPremises(options.input));
  const same = (input: WorkflowAutomaticInput) => contentHashOf(workflowJobPremises(input)) === premises;
  if (!same(base.value.input)) return workflowFailure("job_payload_conflict", "classification scope, source turn, watermark and prompt hash cannot change");

  const resultOrder = new Map(loaded.state.assets.map((asset, index) => [asset.versionId, index]));
  let latest: PaidClassification | null = null, order = -1;

  for (const job of loaded.state.jobs) {
    if (job.domain !== "workflow" || job.scope !== options.input.scope || job.state !== "succeeded") continue;

    const candidate = view(job.jobId);
    if (!candidate.ok) {
      if (candidate.code === "job_not_found") continue;
      return candidate;
    }

    if (candidate.value.input.purpose !== "classify" || !same(candidate.value.input)) continue;

    let link = candidate.value.input.retryOf, descendant = job.jobId === options.input.jobId;
    const visited = new Set([job.jobId]);

    while (!descendant && link !== undefined) {
      if (visited.has(link.jobId)) return workflowFailure("invalid_job_retry", "cyclic retry provenance");
      visited.add(link.jobId);
      const parent = view(link.jobId);
      if (!parent.ok) return parent;
      if (link.jobId === options.input.jobId) {
        descendant = true;
        break;
      }
      link = parent.value.input.retryOf;
    }

    const outcome = candidate.value.latestOutcome, usage = candidate.value.usage;
    if (!descendant || outcome?.kind !== "classified") continue;

    if (usage === undefined || !("tokens" in usage)) return workflowFailure("job_result_corrupt", job.jobId);

    const position = resultOrder.get(candidate.value.resultVersionId ?? "") ?? -1;
    if (position > order) {
      order = position;
      latest = { task: outcome.task, usage, jobId: job.jobId };
    }
  }

  return { ok: true, value: latest };
}

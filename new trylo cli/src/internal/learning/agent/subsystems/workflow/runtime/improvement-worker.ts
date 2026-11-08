import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowImprovementRuntimeOptions, WorkflowImprovementOpportunityRecord, WorkflowImprovementFunding } from "./improvement-contracts.js";
import { awaitWorkflowProposal } from "./improvement-cancellation.js";
import { prepareWorkflowImprovement } from "./improvement-preparation.js";
import { workWorkflowResearch, type WorkflowResearchWorkResult } from "./research-worker.js";
import { buildWorkflowCandidate } from "./improvement-candidate.js";

/** One proposal, one central reservation, no repair loop or implicit provider failover. */
export async function workWorkflowImprovement(options: WorkflowImprovementRuntimeOptions,
  funded: WorkflowImprovementFunding,
  record: WorkflowImprovementOpportunityRecord, signal: AbortSignal): Promise<WorkflowLearningResult<WorkflowResearchWorkResult>> {
  if (options.funding.research !== undefined && options.store.saveResearch !== undefined) {
    let model: ReturnType<typeof options.newModel>;
    try { model = options.newModel(); }
    catch { return workflowFailure("workflow_worker_unavailable", "Workflow researcher provider is unavailable"); }
    if (model.research !== undefined) return workWorkflowResearch(options, funded, record, model, signal);
    return workWorkflowImprovementOnce({ ...options, newModel: () => model }, funded, record, signal);
  }
  return workWorkflowImprovementOnce(options, funded, record, signal);
}

/** Compatibility for a custom proposal-only model. New native models own their internal research loop. */
async function workWorkflowImprovementOnce(options: WorkflowImprovementRuntimeOptions,
  funded: WorkflowImprovementFunding,
  record: WorkflowImprovementOpportunityRecord, signal: AbortSignal): Promise<WorkflowLearningResult<{ readonly versionId: string }>> {
  const funding = options.funding, reserved = await funding.reserve(funded);
  if (!reserved.ok) return reserved;

  const reservation = reserved.value;
  const end = async (code: string) => {
    const finished = await funding.finish(reservation, { kind: signal.aborted ? "cancelled" : "failed", reason: code });
    return finished.ok ? workflowFailure(code, "Workflow proposal did not commit") : finished;
  };

  if (signal.aborted) {
    const settled = await funding.settle(reservation, { kind: "reported", totalTokens: 0 });
    return settled.ok ? end("cancelled") : settled;
  }

  const prepared = await prepareWorkflowImprovement(options, record);
  if (!prepared.ok) {
    const settled = await funding.settle(reservation, { kind: "reported", totalTokens: 0 });
    return settled.ok ? end(prepared.code) : settled;
  }

  const { parent, view, evidence, history, feedback } = prepared.value;

  if (!(options.contextPublicData ?? options.publicData)({ opportunity: record.opportunity, evidence, parent: parent?.artifact ?? null, history, feedback,
    ...(options.centralContent === undefined ? {} : { centralContent: options.centralContent }) })) {
    const settled = await funding.settle(reservation, { kind: "reported", totalTokens: 0 });
    return settled.ok ? end("workflow_private_report") : settled;
  }

  let model: ReturnType<typeof options.newModel>;

  try { model = options.newModel(); }
  catch {
    const settled = await funding.settle(reservation, { kind: "reported", totalTokens: 0 });
    return settled.ok ? end("workflow_worker_unavailable") : settled;
  }

  const completed = await awaitWorkflowProposal(() => model.propose({ opportunity: record.opportunity, evidence,
    ...(parent === undefined ? {} : { parent: parent.artifact }), history, feedback,
    ...(options.centralContent === undefined ? {} : { centralContent: options.centralContent }) }, signal, reservation.maxTokens), signal);
  const result = completed.kind === "completed" ? completed.value
    : workflowFailure(completed.kind === "cancelled" ? "cancelled" : "workflow_worker_unavailable", "Workflow researcher did not return an admissible result");
  const usage = model.usage();
  const settled = await funding.settle(reservation, usage.uncertain || completed.kind !== "completed"
    ? { kind: "unknown", reason: "workflow_proposal_usage_incomplete" }
    : { kind: "reported", totalTokens: usage.tokens });
  if (!settled.ok) return settled;

  if (usage.calls > 1 || usage.tokens > reservation.maxTokens) return end("learning_budget_exhausted");

  if (!result.ok) return end(result.code);

  if (signal.aborted) return end("cancelled");

  if (!options.publicData(result.value)) return end("workflow_private_report");

  const built = buildWorkflowCandidate({ opportunity: record.opportunity, evidence, proposal: result.value, history,
    ...(parent === undefined ? {} : { parent: parent.artifact, parentVersionId: parent.versionId }) }, view.versions);
  if (!built.ok) return end(built.code);

  const committed = await options.store.publish(built.value, new Date(options.now()).toISOString(),
    { reservation, signal, now: options.now });
  if (!committed.ok) return end(committed.code);

  return committed;
}

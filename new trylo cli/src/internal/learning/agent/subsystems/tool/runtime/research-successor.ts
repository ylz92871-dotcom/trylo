import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { centralLearningRemaining } from "../../../../control/coordination-contract.js";
import { decodeToolLearningPlan, planVersionId, toolLearningJobId } from "../domain/evolution/pipeline.js";
import { decodeToolResearchSupplement, toolResearchSupplementId } from "../domain/evolution/research-origin.js";
import { readToolResearchLineage, toolResearchSuccessorPlan, unqualifiedPredecessor } from "../domain/evolution/research-lineage.js";
import { toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { planForJob } from "./pipeline-records.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { nominateToolLearningSource } from "./learning-funding.js";

/** Explicit host reception for new contract material after an unqualified
 * completed episode. Idempotent reception never starts a model or adds funds. */
export async function appendToolResearchSuccessor(options: { readonly boardRoot: string; readonly scope: string;
  readonly centralScope: string; readonly now: () => number; readonly authorized: () => boolean }, raw: unknown, signal: AbortSignal) {
  const supplement = decodeToolResearchSupplement(raw);
  if (supplement === undefined || supplement.scope !== options.scope) return pipelineFailure("invalid_research_supplement", "A complete content-bound material is required");

  const prepared = await withBoardWriter(options.boardRoot, async store => {
    if (!options.authorized() || signal.aborted) return pipelineFailure("tool_learning_authorization_required", "Research reception is inactive");

    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const previous = planForJob(loaded.state, supplement.previousJobId);
    const root = previous === undefined ? undefined : readToolResearchLineage(loaded.state, previous);
    if (previous === undefined || root === undefined || !unqualifiedPredecessor(loaded.state, previous, supplement.previousResultRef)) {
      return pipelineFailure("research_predecessor_not_qualified", "The original terminal result and settled usage must be inspectable");
    }

    const identity = toolLearningFundingIdentity(previous), grant = loaded.state.centralLearningGrants?.find(row => row.grantId === identity.grantId);
    const issue = loaded.state.learningIssues?.find(row => row.issueId === identity.issueId);
    if (grant?.status !== "open" || grant.budgetId === undefined || grant.scope !== options.centralScope || issue?.scope !== options.centralScope
      || issue.decision.kind !== "focused_learning" || issue.decision.revision !== grant.focusRevision) return pipelineFailure("research_original_grant_unavailable", identity.grantId);

    if (grant.claim !== undefined || grant.reservations.some(row => row.state === "reserved")) return pipelineFailure("research_original_worker_in_flight", identity.grantId);

    const remaining = centralLearningRemaining(grant);
    if (remaining.calls < 1 || remaining.tokens < 1 || remaining.steps < 1) return pipelineFailure("learning_budget_exhausted", identity.grantId);

    const known = new Set(root.supplements.flatMap(row => row.materials.map(material => material.contentHash)));
    if (!supplement.materials.some(material => !known.has(material.contentHash))) return pipelineFailure("research_new_material_required", supplement.previousResultRef);

    const plan = toolResearchSuccessorPlan(previous, root, supplement), jobId = toolLearningJobId(plan);
    if (decodeToolLearningPlan(plan) === undefined) return pipelineFailure("invalid_plan", "The successor cannot preserve the original plan contract");

    const siblings = loaded.state.assets.flatMap(row => {
      const candidate = decodeToolLearningPlan(row.content);
      return candidate?.researchOrigin?.previousJobId === supplement.previousJobId && row.versionId === planVersionId(toolLearningJobId(candidate)) ? [candidate] : [];
    });
    if (siblings.some(candidate => toolLearningJobId(candidate) !== jobId)) return pipelineFailure("research_successor_conflict", "Continue the existing successor before adding another episode");

    const saved = await savePipelineAsset(store, { versionId: toolResearchSupplementId(supplement), content: supplement,
      kind: "workflow", scope: options.scope, source: "inferred", issuedAt: supplement.createdAt,
      observations: [supplement.previousResultRef, ...supplement.materials.map(row => row.ref)] });
    if (!saved.ok) return saved;

    // Reserve the immutable leaf while the same writer still excludes a
    // competing successor. The existing queue owner alone enqueues its job;
    // an interrupted reception resumes this exact plan rather than forking it.
    const reserved = await savePipelineAsset(store, { versionId: planVersionId(jobId), content: plan,
      kind: "workflow", scope: options.scope, source: "inferred", issuedAt: plan.createdAt,
      observations: plan.trigger.evidenceRefs });

    return reserved.ok ? { ok: true as const, plan, jobId, grantId: identity.grantId, issueId: identity.issueId,
      originalSpent: contentHashOf(grant.reservations) } : reserved;
  });
  if (!prepared.ok) return "reason" in prepared ? pipelineFailure(prepared.reason, prepared.detail) : prepared;

  const enqueued = await enqueueToolLearningPlan(options.boardRoot, prepared.plan,
    { commandGuard: () => options.authorized() && !signal.aborted });
  if (!enqueued.ok) return enqueued;

  const nominated = await nominateToolLearningSource(options, prepared.plan, signal);

  return nominated.ok ? { ...prepared, state: enqueued.state } : nominated;
}

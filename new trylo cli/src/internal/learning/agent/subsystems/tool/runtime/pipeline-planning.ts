import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolLearningPlan, ToolDiscoverySummary, ToolLearningRecipe } from "../domain/evolution/pipeline.js";
import { decodeToolLearningRecipe, toolLearningJobId } from "../domain/evolution/pipeline.js";
import type { ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { decodeToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { recordOf } from "../domain/evolution/parse.js";
import { autonomousRecipeVersionId, decisionBindingFailure, prepareLearningRequest } from "./learning-context.js";
import { pipelineFailure, savePipelineAsset, type PipelineFailure } from "./pipeline-assets.js";
import type { ToolPipelineServices } from "./pipeline-services.js";
import { researchInspectionKnown } from "./pipeline-research.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import type { ToolResearchBoundary } from "../domain/evolution/research.js";
import { decodeApprovedToolContractRevision, toolContractProposalId } from "../domain/evolution/contract-revision.js";
import { normalizeToolPlanningDecision } from "./planning-normalization.js";
import { toolLearningProductionFailures, toolProductionFailureFeedback } from "./production-check-reader.js";
import { toolLearningAcquisitionFailures } from "./acquisition-failure-reader.js";
import { toolLearningFeedbackInputFacts } from "./feedback-input-facts.js";
import { prepareToolPlanningContext } from "./pipeline-planning-context.js";
import { guardPureProductionRegression } from "./pure-production-regression.js";
import { retainRejectedToolPlanningResponse } from "./planning-response.js";

export type PlannedRecipe = { readonly versionId: string; readonly recipe: ToolLearningRecipe };

type Planned = { readonly ok: true; readonly decision: ToolLearningDecision; readonly decisionVersionId: string;
  readonly selected?: PlannedRecipe; readonly feedback: string; readonly inputFingerprint: string;
  readonly allowance: import("../domain/evolution/learning-plan.js").ToolLearningAllowance };

/** A fingerprint ignores this worker's own result bookkeeping, so waiting is evidence-driven. */
export function toolLearningInputFingerprint(state: BoardState, plan: ToolLearningPlan): string {
  const productionFailures = toolLearningProductionFailures(state, plan);
  const acquisitionFailures = toolLearningAcquisitionFailures(state, plan);
  const feedbackInputs = toolLearningFeedbackInputFacts(state, plan);
  const issues = (state.learningIssues ?? []).filter(issue => issue.reports.some(report => "subsystem" in report.source
    && report.source.subsystem === "tool" && report.source.versionId === toolLearningJobId(plan))).map(issue => issue.issueId);

  return contentHashOf({ contractRevisions: toolContractRevisionInputs(state, plan.scope),
    ...(acquisitionFailures.ok && acquisitionFailures.failures.length === 0 ? {} : {
      acquisitionFailures: acquisitionFailures.ok ? acquisitionFailures.failures.map(failure => failure.ref).sort() : { code: acquisitionFailures.code } }),
    productionFailures: productionFailures.ok ? productionFailures.failures : { code: productionFailures.code },
    allowances: (state.centralLearningGrants ?? []).filter(grant => issues.includes(grant.issueId))
    .map(grant => ({ grantId: grant.grantId, status: grant.status, allowance: grant.allowance })), assets: state.assets.filter(asset => asset.scope === plan.scope
    && asset.kind === "tool_package")
    .map(asset => ({ versionId: asset.versionId, contentHash: asset.contentHash, lifecycle: state.proposals.find(proposal => proposal.proposalId === asset.createdFromProposalId)?.lifecycle ?? "missing" }))
    .concat(feedbackInputs.ok ? [...feedbackInputs.feedback] : []),
  ...(feedbackInputs.ok ? {} : { feedbackInputFailure: feedbackInputs.code }),
  uses: feedbackInputs.ok ? feedbackInputs.uses : [],
  trials: (state.toolTrials ?? []).filter(trial => trial.scope === plan.scope) });
}

/** User approval/withdrawal is new evidence; an unapproved draft or our own research bookkeeping is not. */
function toolContractRevisionInputs(state: BoardState, scope: string) {
  return state.assets.flatMap(asset => {
    if (asset.kind !== "workflow" || asset.scope !== scope || !recordOf(asset.content) || asset.content.type !== "tool_contract_revision_approved") return [];

    const revision = decodeApprovedToolContractRevision(asset.content);
    const proposal = revision === undefined ? undefined : state.assets.find(item => item.versionId === toolContractProposalId(revision.proposal));
    const facts = (item: typeof asset) => ({ versionId: item.versionId, contentHash: item.contentHash,
      lifecycle: state.proposals.find(row => row.proposalId === item.createdFromProposalId)?.lifecycle ?? "missing",
      removed: state.tombstones.some(row => row.entityId === item.versionId || row.entityId === item.createdFromProposalId) });

    return [{ approval: facts(asset), proposal: proposal === undefined ? null : facts(proposal) }];
  });
}

export async function planToolLearningStep(input: { readonly boardRoot: string; readonly plan: ToolLearningPlan;
  readonly jobId: string; readonly attempt: number; readonly search: ToolDiscoverySummary; readonly services: ToolPipelineServices;
  readonly signal: AbortSignal; readonly occurredAt: string; readonly step?: number; readonly researchBoundary?: ToolResearchBoundary;
  readonly inquiryFailureRef?: string }): Promise<Planned | PipelineFailure> {
  if (input.services.plan === undefined) return pipelineFailure("verification_recipe_required", "neither an explicit recipe nor a planner is available");

  const allowance = await input.services.allowance?.(input.plan, input.signal);
  if (allowance === undefined) return pipelineFailure("learning_allowance_required", "the central Board has not granted learning resources");

  if (allowance.callsRemaining < 1 || allowance.tokensRemaining < 1) return pipelineFailure("learning_budget_exhausted", "central lifetime allowance is exhausted");

  const preparedContext = await prepareToolPlanningContext(input, allowance);
  if (!preparedContext.ok) return preparedContext;

  const { state, context, researchBoundary, productionFailures } = preparedContext;
  const raw = await input.services.plan(context, input.signal);

  if (input.signal.aborted) return pipelineFailure("cancelled", "learning was cancelled");

  const normalizedInput = normalizeToolPlanningDecision(raw, context, state);
  if (!normalizedInput.ok) return normalizedInput;

  const decision = decodeToolLearningDecision(normalizedInput.value);
  if (decision === undefined) {
    const retained = await retainRejectedToolPlanningResponse({ ...input, scope: input.plan.scope, step: input.step ?? 1, context, value: raw });
    if (!retained.ok) return "reason" in retained ? pipelineFailure(retained.reason, retained.detail) : retained;
    return pipelineFailure("invalid_learning_decision", "planner did not return a bounded strategy contract; retain the original rejection before continuation");
  }

  if (decision.action === "research" && researchBoundary !== undefined) return pipelineFailure("research_closed", "the bounded final decision cannot launch further investigation");

  const binding = decisionBindingFailure(decision, context);
  if (binding !== undefined) return pipelineFailure(binding, "planned strategy does not bind the available facts/contracts");

  if (decision.action === "research" && "inspect" in decision && !researchInspectionKnown(decision.inspect, context.search, context.research ?? [])) return pipelineFailure("unknown_inspection_candidate", "inspect a discovered candidate before requesting its source");

  const regression = await guardPureProductionRegression({ boardRoot: input.boardRoot, plan: input.plan, decision,
    jobId: input.jobId, attempt: input.attempt, issuedAt: input.occurredAt,
    ...(input.services.productionRegression === undefined ? {} : { productionRegression: input.services.productionRegression }) });
  if (!regression.ok) return regression;

  const prepared = "request" in decision ? await prepareLearningRequest(input.boardRoot, decision, input.plan) : undefined;
  if (prepared !== undefined && !prepared.ok) return prepared;

  // A correction may repair source against frozen samples. Every attempt still
  // reserves from the same grant; research/planning and unknown usage cannot refill it.
  const request = prepared?.ok === true ? { ...prepared.request, maxAttempts: Math.max(1, Math.min(2, allowance.callsRemaining - 1)) } : undefined;
  const normalized: ToolLearningDecision = request === undefined || !("request" in decision) ? decision : { ...decision, request };
  const decisionVersionId = toolLearningDecisionVersionId({ jobId: input.jobId, attempt: input.attempt, step: input.step ?? 1, decision: normalized });
  const selected = request === undefined ? undefined : { versionId: autonomousRecipeVersionId(normalized),
    recipe: { type: "tool_learning_recipe" as const, schemaVersion: 1 as const, automation: "after_turn" as const, request } };
  const selectedToolVersionId = normalized.action === "reuse" || normalized.action === "refine"
    ? context.availableTools.find(tool => tool.toolId === normalized.toolId)?.versionId : undefined;

  if (selected !== undefined && decodeToolLearningRecipe(selected.recipe) === undefined) return pipelineFailure("invalid_internal_recipe", "frozen recipe exceeds the existing request contract");

  const inputFingerprint = toolLearningInputFingerprint(state, input.plan);
  const saved = await withBoardWriter(input.boardRoot, async store => {
    const current = await store.load();
    if (!current.ok) return pipelineFailure(current.reason, current.detail);

    const job = current.state.jobs.find(item => item.jobId === input.jobId);
    if (job?.state !== "running" || job.attempt !== input.attempt) return pipelineFailure("stale_job_result", input.jobId);

    const archived = await savePipelineAsset(store, { versionId: decisionVersionId, kind: "workflow", scope: input.plan.scope,
      source: "inferred", issuedAt: input.occurredAt, content: { type: "tool_learning_decision", schemaVersion: 1,
        jobId: input.jobId, attempt: input.attempt, step: input.step ?? 1, contextHash: contentHashOf(context), decision: normalized, grantId: allowance.grantId,
        ...(selectedToolVersionId === undefined ? {} : { selectedToolVersionId }) } });
    if (!archived.ok || selected === undefined) return archived;

    return savePipelineAsset(store, { versionId: selected.versionId, kind: "verification_recipe", content: selected.recipe,
      scope: input.plan.scope, source: "inferred", issuedAt: input.occurredAt });
  });
  if (!saved.ok) return "code" in saved ? saved : pipelineFailure(saved.reason, saved.detail);

  return { ok: true, decision: normalized, decisionVersionId, feedback: [prepared?.ok === true ? prepared.feedback : "",
    toolProductionFailureFeedback(productionFailures.failures)].filter(Boolean).join("\n"),
    inputFingerprint, allowance, ...(selected === undefined ? {} : { selected }) };
}

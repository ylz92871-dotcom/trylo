import type { BoardState } from "../../../../control/state.js";
import type { LearningIssue } from "../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../control/hash.js";
import { isToolPipelineCounter } from "../domain/evolution/pipeline-lifetime.js";
import { toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { planForJob, resultForJob } from "./pipeline-records.js";
import { toolFundingOriginFromBoard } from "./tool-funding-origin.js";
import { toolLearningInputFingerprint } from "./pipeline-planning.js";
import { frozenToolRecipeForResult } from "./frozen-recipe.js";
import { recipeForPlan } from "./pipeline-queue.js";
import { pipelineFailure } from "./pipeline-assets.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningJobId } from "../domain/evolution/pipeline.js";
import type { CentralLearningSourceContext } from "../../../../control/source-context.js";
import { readToolResearchLineage } from "../domain/evolution/research-lineage.js";

/** The same original task identity is used by PA selection and managed execution. */
export function selectToolFocusedSource(state: BoardState, issue: LearningIssue | undefined, scope: string, centralScope: string) {
  if (issue === undefined || issue.scope !== centralScope) return pipelineFailure("learning_issue_not_found", "The canonical tool issue is unavailable");

  const sources = issue.reports.flatMap(row => "subsystem" in row.source && row.source.subsystem === "tool" ? [row.source] : []);
  const ids = [...new Set(sources.map(row => row.versionId))];
  if (ids.length === 0 || issue.reports.some(row => !("subsystem" in row.source) || row.source.subsystem !== "tool")) {
    return pipelineFailure("tool_learning_source_mismatch", "A tool issue must identify one original task");
  }

  const plans = ids.map(id => planForJob(state, id));
  if (plans.some(plan => plan === undefined)) return pipelineFailure("tool_learning_source_unavailable", issue.issueId);

  const leaves = plans.filter(plan => !plans.some(other => other?.researchOrigin?.previousJobId === toolLearningJobId(plan!)));
  if (leaves.length !== 1) return pipelineFailure("tool_learning_source_mismatch", "The original research chain has competing leaves");

  const plan = leaves[0]!, jobId = toolLearningJobId(plan), job = state.jobs.find(row => row.jobId === jobId);
  const lineage = plan.researchOrigin === undefined ? undefined : readToolResearchLineage(state, plan);
  if (ids.length > 1 && (lineage === undefined || ids.some(id => !lineage.plans.some(ancestor => toolLearningJobId(ancestor) === id)))) {
    return pipelineFailure("tool_learning_source_mismatch", "Reports do not share the exact original research lineage");
  }

  if (plan === undefined || plan.scope !== scope || job?.domain !== "tool" || job.scope !== scope
    || sources.some(source => source.taskId !== plan.trigger.runId)) return pipelineFailure("tool_learning_source_unavailable", jobId);

  const origin = toolFundingOriginFromBoard(state, plan);
  if (!origin.ok) return origin;

  const identity = toolLearningFundingIdentity(plan);

  return identity.issueId === issue.issueId ? { ok: true as const, jobId, grantId: identity.grantId, plan, job }
    : pipelineFailure("tool_learning_source_mismatch", "The issue does not own this plan's original grant");
}

/** Current input excludes this issue's financial commitment: committing the offer
 * is not new semantic evidence. Worker wake-up still uses its original full fingerprint.
 */
export function toolCentralStageIdentity(state: BoardState, source: Extract<ReturnType<typeof selectToolFocusedSource>, { ok: true }>,
  mode: "manual" | "after_turn", modelRef: string, centralSourceContext?: CentralLearningSourceContext) {
  const frozen = frozenToolRecipeForResult(state, source.job, source.plan, resultForJob(state, source.jobId, source.job.attempt));
  if (!frozen.ok) return frozen;

  const selected = frozen.selected ?? recipeForPlan(state, source.plan);
  const fingerprint = toolCentralSemanticFingerprint(state, source.plan);
  const stageRef = `tool-stage:${source.jobId}:${source.job.attempt + 1}:${contentHashOf({ plan: source.plan, attempt: source.job.attempt, fingerprint,
    ...(centralSourceContext === undefined ? {} : { centralSourceContext }),
    recipeVersionId: selected?.versionId ?? null })}`;
  const policyRef = toolCentralPolicyRef(mode, modelRef);
  const sourceBindingRef = toolCentralSourceBinding(source.jobId, stageRef, policyRef);

  return { ok: true as const, stageRef, policyRef, sourceBindingRef };
}

export function toolCentralSemanticFingerprint(state: BoardState, plan: ToolLearningPlan): string {
  const identity = toolLearningFundingIdentity(plan);
  const semanticState = { ...state, centralLearningGrants: (state.centralLearningGrants ?? []).filter(grant => grant.issueId !== identity.issueId) };
  return toolLearningInputFingerprint(semanticState, plan);
}

export function toolCentralPolicyRef(mode: "manual" | "after_turn", modelRef: string): string {
  return `tool-policy:${contentHashOf({ policy: "bounded-research-construction-v1", mode, modelRef })}`;
}

export function toolCentralSourceBinding(jobId: string, stageRef: string, policyRef: string): string {
  return `tool-source:${contentHashOf({ jobId, stageRef, policyRef })}`;
}

export function toolCentralStageAttempt(stageRef: string) {
  const match = /^tool-stage:(tool-learning_v1_[a-f0-9]{64}):([1-9][0-9]{0,9}):[a-f0-9]{64}$/.exec(stageRef);
  return match === null || !isToolPipelineCounter(Number(match[2])) ? undefined : { jobId: match[1]!, attempt: Number(match[2]) };
}

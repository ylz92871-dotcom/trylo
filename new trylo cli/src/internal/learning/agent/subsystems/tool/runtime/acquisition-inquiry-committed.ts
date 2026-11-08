import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolLearningPlan, ToolDiscoverySummary } from "../domain/evolution/pipeline.js";
import { decodeToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { MAX_TOOL_RESEARCH_STEPS } from "../domain/evolution/research.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import { recordOf } from "../domain/evolution/parse.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";
import { mergeDiscovery, toolPlanningResearch } from "./pipeline-research.js";

/** A committed terminal strategy can be recovered without resending its model invocation. */
export function committedInquiryDecision(state: BoardState, input: { readonly jobId: string; readonly attempt: number; readonly plan: ToolLearningPlan; readonly search: ToolDiscoverySummary }) {
  const rows = state.assets.filter(row => recordOf(row.content) && row.content.type === "tool_learning_decision"
    && row.content.jobId === input.jobId && row.content.attempt === input.attempt);
  if (rows.length > MAX_TOOL_RESEARCH_STEPS + 1) return pipelineFailure("invalid_inquiry_decision", input.jobId);

  let selected: { step: number; decision: NonNullable<ReturnType<typeof decodeToolLearningDecision>>; decisionVersionId: string; occurredAt: string } | undefined;
  const seen = new Set<number>();

  for (const asset of rows) {
    const raw = asset.content;
    if (!recordOf(raw)) return pipelineFailure("invalid_inquiry_decision", input.jobId);

    const decision = decodeToolLearningDecision(raw.decision), step = raw.step;
    if (decision === undefined || typeof step !== "number" || !Number.isSafeInteger(step) || step < 1 || seen.has(step)
      || !assetAvailable(state, asset) || asset.scope !== input.plan.scope || asset.kind !== "workflow" || asset.source !== "inferred" || raw.schemaVersion !== 1
      || asset.versionId !== toolLearningDecisionVersionId({ jobId: input.jobId, attempt: input.attempt, step, decision })
      || asset.contentHash !== contentHashOf(raw)) return pipelineFailure("invalid_inquiry_decision", input.jobId);

    seen.add(step);
    if (selected === undefined || step > selected.step) selected = { step, decision, decisionVersionId: asset.versionId, occurredAt: asset.createdAt };
  }

  if (selected === undefined || selected.decision.action === "research") return { ok: true as const, decision: undefined };

  const prior = toolPlanningResearch(state, input.plan, input.jobId);
  if (!prior.ok) return prior;

  let search = input.search;

  for (const step of prior.research.filter(row => row.jobId === input.jobId && row.attempt === input.attempt)) if (step.discovery !== undefined) search = mergeDiscovery(search, step.discovery);

  return { ok: true as const, decision: selected.decision, decisionVersionId: selected.decisionVersionId, occurredAt: selected.occurredAt, search };
}

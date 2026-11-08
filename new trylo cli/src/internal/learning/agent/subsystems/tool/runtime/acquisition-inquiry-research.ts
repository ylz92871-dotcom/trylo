import type { ToolPipelineServices } from "./pipeline-services.js";
import type { ToolLearningPlan, ToolDiscoverySummary } from "../domain/evolution/pipeline.js";
import { MAX_TOOL_RESEARCH_STEPS, type ToolResearchBoundary } from "../domain/evolution/research.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { planToolLearningStep } from "./pipeline-planning.js";
import { performToolResearch, researchRequest, toolPlanningResearch } from "./pipeline-research.js";
import { pipelineFailure } from "./pipeline-assets.js";

/** This continuation owns research and a strategy proposal only, never construction or acquisition. */
export async function researchAcquisitionInquiry(input: { readonly boardRoot: string; readonly plan: ToolLearningPlan; readonly jobId: string;
  readonly attempt: number; readonly failureRef: string; readonly search: ToolDiscoverySummary; readonly services: ToolPipelineServices;
  readonly signal: AbortSignal; readonly now: () => number }) {
  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const prior = toolPlanningResearch(loaded.state, input.plan, input.jobId);
  if (!prior.ok) return prior;

  let research = prior.research, search = input.search, boundary: ToolResearchBoundary | undefined;

  for (let step = 1; step <= MAX_TOOL_RESEARCH_STEPS + 1; step++) {
    const occurredAt = new Date(input.now()).toISOString();
    const planned = await planToolLearningStep({ ...input, search, occurredAt, step,
      inquiryFailureRef: input.failureRef, ...(boundary === undefined ? {} : { researchBoundary: boundary }) });
    if (!planned.ok) return planned;

    if (planned.decision.action !== "research") return { ok: true as const, decision: planned.decision, decisionVersionId: planned.decisionVersionId,
      search, occurredAt };

    if (planned.allowance.callsRemaining < 2 || step >= MAX_TOOL_RESEARCH_STEPS + 1) return pipelineFailure("learning_budget_exhausted", "Research retained its existing grant boundary");

    const next = await performToolResearch({ ...input, request: researchRequest(planned.decision), prior: research, search, occurredAt: new Date(input.now()).toISOString() });
    if (!next.ok) {
      if (boundary === undefined && ["research_request_repeated", "research_capacity"].includes(next.code)) {
        boundary = { furtherInvestigation: "closed", reason: next.code as "research_request_repeated" | "research_capacity" };
        continue;
      }
      return next;
    }

    research = [...research, next.step];
    search = next.search;

    if (!next.novel) boundary = { furtherInvestigation: "closed", reason: "research_no_new_information" };
  }

  return pipelineFailure("research_capacity", "The same task cannot expand its research allowance");
}

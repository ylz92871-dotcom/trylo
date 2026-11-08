import type { ToolLearningResult } from "./pipeline.js";
import { TOOL_CYCLE_DEADLINE } from "./cycle-deadline.js";

export const TOOL_CONSTRUCTION_NOT_STARTED = "construction_interrupted_before_generation";
export const TOOL_GENERATION_INTERRUPTED = "generation_worker_interrupted";
const EVIDENCE_STOPS: ReadonlySet<string> = new Set([
  "execution_authorization_required", "learning_allowance_required", "learning_allowance_unavailable", "learning_budget_exhausted",
  "generation_context_exceeds_allowance", "parent_source_evidence_required", "parent_source_read_closed", "parent_source_read_limit",
  TOOL_CYCLE_DEADLINE,
  TOOL_CONSTRUCTION_NOT_STARTED,
  TOOL_GENERATION_INTERRUPTED,
]);

/** Local evidence/resource boundaries are resumable; provider/network failures
 * retain their original terminal policy and never gain an automatic retry here. */
export function toolConstructionNeedsEvidence(code: string): boolean { return EVIDENCE_STOPS.has(code); }

export function toolConstructionHostTimeout(code: string): boolean { return code === "subagent_timed_out" || code === "generation_timeout"; }

export function hasFrozenToolConstruction(result: ToolLearningResult | undefined): result is ToolLearningResult {
  return result !== undefined && (result.outcome === "waiting_evidence" && toolConstructionNeedsEvidence(result.previousCode ?? result.code)
    || result.outcome === "failed" && toolConstructionHostTimeout(result.code))
    && (result.recipeVersionId !== undefined || (result.decision !== undefined && "request" in result.decision));
}

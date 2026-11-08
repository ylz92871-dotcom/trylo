import type { ExperienceReview } from "../experience-port.js";
import { procedureExecutionKey, type ProcedureExecutionContent } from "./procedure.js";
import { isCompilationReview } from "./compilation-review.js";
import { compilationEvidenceOf } from "./compilation-evidence.js";
import type { ExperienceSource, ReviewFact } from "./experience-state.js";
import type { ScopeHypothesis } from "./scope-learning.js";

/** Review checkpoints record knowledge, not defects. Derive the actual repair
 * obligation once for canonical admission and the model request. */
export function compilationRepairRequired(source: ExperienceSource, scope: ScopeHypothesis, compilation: ReviewFact): boolean {
  const failed = compilationEvidenceOf(source.observations, { scope,
    compilationId: compilation.factId, compiledSequence: compilation.sequence })
    .semanticObservations?.some(item => item.outcome === "unhelpful") === true;
  return failed || source.facts.some(item =>
    item.kind === "compilation_exit" && item.compilationId === compilation.factId ||
    item.kind === "decision" && item.versionId === compilation.versionId && item.decision.scopeId === compilation.scopeId &&
    item.decision.action === "block" && item.sequence > compilation.sequence);
}

/** Repair after a counterexample must change delivered practice.
 * Renamed references, source claims and new rationale do not repair execution.
 * Requalified is supplied only after the host recomputes sufficient future
 * source evidence after withdrawal. Old compiled failures remain visible to M.
 * This catches mechanical no-ops; semantic paraphrases still require model review. */
export function compilationRevisionError(current: ProcedureExecutionContent,
  proposed: Pick<ExperienceReview, "decision" | "compact" | "procedure">,
  mode: "ordinary" | "repair" | "requalified"): string | undefined {
  if (mode !== "repair" || !isCompilationReview(proposed)) return undefined;
  return procedureExecutionKey(current) === procedureExecutionKey({ compact: proposed.compact,
    ...(proposed.procedure === undefined ? {} : { procedure: proposed.procedure }) }) ? "method_review_unchanged_procedure" : undefined;
}

import { fields, list, text } from "../../../../../validation/json-shape.js";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowResearchFinding } from "./research-contracts.js";

/** Shape only: the model adapter and original checkpoint writer separately verify exposure/provenance. */
export function parseWorkflowResearchFinding(value: unknown): WorkflowLearningResult<WorkflowResearchFinding> {
  if ((!fields(value, ["kind", "statement", "conditions", "sourceRefs"])
    && !fields(value, ["kind", "statement", "conditions", "sourceRefs", "nextQuestion"]))
    || !["hypothesis", "interpretation", "counterexample", "open_question"].includes(String(value.kind))
    || !text(value.statement, 1500) || !text(value.conditions, 1000)
    || !list(value.sourceRefs, 1, 8) || !value.sourceRefs.every(ref => text(ref, 4096))
    || new Set(value.sourceRefs).size !== value.sourceRefs.length
    || value.nextQuestion !== undefined && !text(value.nextQuestion, 1000)) {
    return workflowFailure("invalid_workflow_research_finding", "A working finding needs a kind, bounded statement/conditions, one to eight distinct source refs and an optional next question");
  }
  return { ok: true, value: { kind: value.kind as WorkflowResearchFinding["kind"], statement: value.statement,
    conditions: value.conditions, sourceRefs: [...value.sourceRefs],
    ...(value.nextQuestion === undefined ? {} : { nextQuestion: value.nextQuestion }) } };
}

import { decodeToolOpportunityEvidence, decodeToolOpportunityReport, isOpportunitySource, type ToolExecutionFact, type ToolOpportunityEvidence, type ToolOpportunityGrounding, type ToolOpportunitySource } from "../domain/awareness/opportunity.js";
import { textOf } from "../domain/evolution/parse.js";
import type { ToolObservedCapability } from "../domain/awareness/observed-catalog.js";
import type { ToolTaskText } from "../domain/awareness/task-text.js";
import { selectObservedCatalog } from "./observed-catalog.js";

export type ToolOpportunityInput = {
  readonly turnId: string;
  readonly reportId: string;
  readonly source: ToolOpportunitySource;
  readonly report: unknown;
  readonly executions?: readonly ToolExecutionFact[];
  /** Trusted host contract, outside the model's report payload. */
  readonly hostGrounding?: ToolOpportunityGrounding;
};

export type ToolOpportunityResult =
  | { readonly kind: "accepted"; readonly reportId: string }
  | { readonly kind: "ignored"; readonly reason: "existing_configuration_sufficient" | "closed" | "duplicate" | "throttled" }
  | { readonly kind: "invalid"; readonly code: "invalid_opportunity" | "unbound_tool_calls" };

export function bindToolOpportunity(input: ToolOpportunityInput, observed: readonly ToolExecutionFact[],
  catalog?: readonly ToolObservedCapability[], task?: ToolTaskText): ToolOpportunityEvidence | ToolOpportunityResult {
  if (!textOf(input.turnId, 160) || !textOf(input.reportId, 160) || !isOpportunitySource(input.source)) return { kind: "invalid", code: "invalid_opportunity" };

  const assessment = decodeToolOpportunityReport(input.report);
  if (assessment === undefined) return { kind: "invalid", code: "invalid_opportunity" };

  if (assessment.existingCapability === "configuration_sufficient") return { kind: "ignored", reason: "existing_configuration_sufficient" };

  // Model supplied copies of facts are never authoritative; explicit external sources may carry host evidence.
  const available = input.source === "model" ? observed : input.executions ?? observed;
  const executions = available.filter(fact => assessment.toolCallIds.includes(fact.toolCallId)).slice(-16);
  const bound = decodeToolOpportunityEvidence({ reportId: input.reportId, source: input.source, assessment, executions,
    ...(catalog === undefined ? {} : { catalog: selectObservedCatalog(catalog, assessment, executions.map(fact => fact.tool)) }),
    ...(task === undefined ? {} : { task }),
    ...(input.hostGrounding === undefined ? {} : { grounding: input.hostGrounding }) });

  return bound !== undefined && (bound.task === undefined || bound.task.turnId === input.turnId) ? bound
    : { kind: "invalid", code: "unbound_tool_calls" };
}

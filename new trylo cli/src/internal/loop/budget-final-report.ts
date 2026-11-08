import type { ToolPort } from "../ports/tools.js";
import type { Engine } from "./runner-engine.js";
import type { LoopPorts } from "./runner.js";
import type { Transcript } from "../protocol/transcript.js";

export const REPORT_CONTENT_INSTRUCTIONS = "Give the final response in the user's requested language and format: report actual work done, validation that actually ran, and any unfinished or unverified requirements. Do not claim full completion merely because a budget ended. Search, list, glob, plans and promises do not create or modify a file. A failed or denied write is not a successful delivery. Claim a file or memory change only when actual successful results support the requested target and content; a successful tool name alone is not that proof. If only discovery ran, explicitly say the requested file was not created. Return only the user-facing report, without restating instructions or internal planning. Return the report itself, not a plan for more work or tool-call markup. Use the existing tool results; do not perform or propose another verification.";
export const FINAL_REPORT_INSTRUCTIONS = "Final request at this turn's provider-request limit. No tools are available for this request. " + REPORT_CONTENT_INSTRUCTIONS;

/** Recent action facts, not a delivery verdict. Do not include arguments or
 * output (which may contain credentials), and never count a prior user turn.
 */
export function finalReportInstructions(transcript: Transcript, output: "report" | "report_and_auxiliary" = "report"): string {
  return reportInstructions(transcript, FINAL_REPORT_INSTRUCTIONS, output);
}

/** Budget and interruption reports share action facts and output-format rules. */
export function reportInstructions(transcript: Transcript, instructions: string, output: "report" | "report_and_auxiliary" = "report"): string {
  let lastUser = transcript.length - 1;

  while (lastUser >= 0 && transcript[lastUser]?.kind !== "user") lastUser -= 1;

  const results = transcript.slice(lastUser + 1).filter((item) => item.kind === "tool_result");
  const facts = results.slice(-64).map((item) => `${item.name}: ${item.outcome}`).join("\n");
  const auxiliary = output === "report_and_auxiliary"
    ? "\nThe report-only restriction governs the user-visible answer. Keep its exact requested language and format; JSON-only means no preamble, calculations, Markdown or extra fields in that answer. An auxiliary channel explicitly requested by a system slot remains separate and must use its prescribed envelope. Do not invent additional channels."
    : "";

  return `${instructions}${auxiliary}\nCurrent user turn tool outcomes (not proof of delivery):\n${facts || "none"}${results.length > 64 ? "\nEarlier outcomes omitted; consult the existing transcript." : ""}`;
}

/** Narrow both the advertised catalog and actual execution. No remembered grant
 * can reopen actions, and even a provider ignoring the empty catalog cannot act.
 * Earlier calls settled before this view is selected; there is nothing to cancel.
 */
export const REPORT_TOOLS: ToolPort = {
  snapshot: () => [],
  async execute(_call, signal) {
    return signal.aborted ? { outcome: "cancelled" } : { outcome: "error", code: "tool_unknown", message: "No tools are available in the reserved final report request" };
  },
  async cancel() { return; },
};

export type BudgetIteration = {
  readonly purpose: "work" | "final_report";
  readonly ports: LoopPorts;
};

/** Read the engine's authoritative allowance; no second counter or quality judge.
 * A steer can refund iterations in the existing gap, so select again each time.
 */
export function budgetIteration(engine: Engine, ports: LoopPorts): BudgetIteration {
  const limit = engine.budget.maxIterations;
  if (engine.budget.finalRequest !== "report_only" || limit === undefined || engine.iterations + 1 < limit) {
    return { purpose: "work", ports };
  }
  return { purpose: "final_report", ports: { ...ports, tools: REPORT_TOOLS } };
}

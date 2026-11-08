import type { Transcript } from "../protocol/transcript.js";
import { REPORT_CONTENT_INSTRUCTIONS, reportInstructions, type BudgetIteration } from "./budget-final-report.js";

export type InterruptionReport = {
  readonly kind: "interruption_report";
  readonly cause: "effect_reconciliation_required" | "output_continuation_no_progress";
};
export type IterationPurpose = BudgetIteration["purpose"] | InterruptionReport;

/** Reporting describes the failed work; it cannot turn uncertainty into delivery. */
export function interruptionReportInstructions(transcript: Transcript, purpose: InterruptionReport,
  output: "report" | "report_and_auxiliary"): string {
  const cause = purpose.cause === "effect_reconciliation_required"
    ? "An action's result is uncertain and remains unconfirmed. Further actions are fenced until that result is reconciled. Do not assume success, retry it, or tell the user to repeat it."
    : "Continuing the provider's truncated response repeated the same content without progress. The task stopped unfinished; do not claim that this report completes it.";
  return reportInstructions(transcript, `${cause} No tools are available for this request. Explain the interruption and what is still unfinished from the recorded facts. ${REPORT_CONTENT_INSTRUCTIONS}`, output);
}

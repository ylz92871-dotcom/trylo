import type { Envelope } from "./envelope.js";

export const PROMPT_BUDGET_COMPONENT = "prompt_budget";
export const PROMPT_BUDGET_SELECTED_STATUS = "selected";

/** Normal budget diagnostics stay auditable without becoming original task facts. */
export function isSelectedPromptBudgetObservation(event: Pick<Envelope, "kind" | "payload">): boolean {
  return event.kind === "observation" && event.payload.component === PROMPT_BUDGET_COMPONENT
    && event.payload.status === PROMPT_BUDGET_SELECTED_STATUS;
}

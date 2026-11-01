import type { JsonValue } from "../../../../protocol/envelope.js";
import type { ToolEvolutionCandidate } from "./contracts.js";

/** Process outcome is observable execution, never a task-quality verdict. */
export type CandidateExecution =
  | { readonly kind: "value"; readonly value: JsonValue }
  | { readonly kind: "tool_error"; readonly code: string; readonly message?: string }
  | { readonly kind: "timeout"; readonly detail: string }
  | { readonly kind: "protocol_error"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "cancelled" };
export type CandidateExecutor = {
  execute(candidate: ToolEvolutionCandidate, input: JsonValue, signal: AbortSignal): Promise<CandidateExecution>;
};

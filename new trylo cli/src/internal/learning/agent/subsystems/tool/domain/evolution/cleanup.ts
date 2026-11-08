import { ToolLearningServiceError } from "./service-error.js";

export type ToolLearningCleanupCode = "worker_retirement_unconfirmed" | "allowance_release_failed" | "cleanup_unconfirmed";

export function isToolLearningCleanupCode(value: unknown): value is ToolLearningCleanupCode {
  return value === "worker_retirement_unconfirmed" || value === "allowance_release_failed" || value === "cleanup_unconfirmed";
}

/** Only fixed host vocabulary is retained; private provider or port bodies are never copied. */
export function toolLearningCleanupCode(error: unknown): ToolLearningCleanupCode {
  if (error instanceof ToolLearningServiceError && error.code === "tool_session_retirement_unconfirmed") return "worker_retirement_unconfirmed";
  return error instanceof Error && /^tool_allowance_release:[a-z_]+$/.test(error.message) ? "allowance_release_failed" : "cleanup_unconfirmed";
}

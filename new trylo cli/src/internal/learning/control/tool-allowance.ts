import type { CentralLearningAllowance } from "./coordination-contract.js";

/** Central policy for one durable tool-learning task, shared by planning and generation.
 * A resumed attempt keeps its lifetime grant; this is never an execution permission. */
export const TOOL_LEARNING_ALLOWANCE: CentralLearningAllowance = Object.freeze({
  // Discovery, interface inspection, revised choice and two-phase npm adaptation
  // must fit one lifetime grant. Existing grants are never expanded on resume.
  schemaVersion: 2, unit: "total_model_tokens", maxCalls: 8, maxTokens: 96_000, maxSteps: 8, maxPromptChars: 24_000,
});

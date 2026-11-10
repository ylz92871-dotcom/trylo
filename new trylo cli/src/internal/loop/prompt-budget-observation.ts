import type { JsonObject } from "../protocol/envelope.js";
import type { PromptBudgetBasisDecision } from "./prompt-measurement.js";
import { PROMPT_BUDGET_COMPONENT, PROMPT_BUDGET_SELECTED_STATUS } from "../protocol/prompt-budget-observation.js";

export type PromptBudgetObservationCoordinates = {
  readonly turnId?: string;
  readonly attemptId?: string;
  readonly streamIndex: number;
  readonly contextTokenLimit?: number;
  readonly explicitOutputAllowance?: number;
};

/** Serializes the selected gate decision; it neither measures nor writes it. */
export function promptBudgetObservationPayload(decision: PromptBudgetBasisDecision,
  coordinates: PromptBudgetObservationCoordinates): JsonObject {
  return {
    component: PROMPT_BUDGET_COMPONENT, status: PROMPT_BUDGET_SELECTED_STATUS,
    basis: decision.basis, tokens: decision.tokens, localEstimate: decision.localEstimate,
    ...(decision.automaticTokens === undefined ? {} : { automaticTokens: decision.automaticTokens }),
    reason: decision.reason, requestDigest: decision.requestDigest,
    streamIndex: coordinates.streamIndex,
    ...(coordinates.turnId === undefined ? {} : { turnId: coordinates.turnId }),
    ...(coordinates.attemptId === undefined ? {} : { attemptId: coordinates.attemptId }),
    ...(coordinates.contextTokenLimit === undefined ? {} : { contextTokenLimit: coordinates.contextTokenLimit }),
    ...(coordinates.explicitOutputAllowance === undefined ? {} : { explicitOutputAllowance: coordinates.explicitOutputAllowance }),
    ...(decision.observedInputTokens === undefined ? {} : { observedInputTokens: decision.observedInputTokens }),
    ...(decision.addedTokens === undefined ? {} : { addedTokens: decision.addedTokens }),
    ...(decision.inputTokenObservation === undefined ? {} : { inputTokenObservation: {
      kind: decision.inputTokenObservation.kind, source: decision.inputTokenObservation.source,
      tokens: decision.inputTokenObservation.tokens,
    } }),
  };
}

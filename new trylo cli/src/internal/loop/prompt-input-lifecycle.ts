import type { Engine } from "./runner-engine.js";
import type { StreamObservation } from "./stream.js";
import type { PromptBudgetBasisDecision, PromptMeasurement } from "./prompt-measurement.js";
import { captureStoredInputBasis } from "./prompt-input-basis.js";
import type { ProviderRequest } from "../ports/provider.js";
import { emitRaw } from "./journal-emit.js";
import { promptBudgetObservationPayload } from "./prompt-budget-observation.js";

/** Emit the exact final prepared decision once. Canonical stream identity is
 * never refunded when the caller redirects the iteration budget. */
export function observePromptInputSelection(engine: Engine, decision: PromptBudgetBasisDecision | undefined,
  request: ProviderRequest): void {
  if (decision === undefined) return;
  emitRaw(engine, "observation", promptBudgetObservationPayload(decision, {
    ...(engine.state.turnId === undefined ? {} : { turnId: engine.state.turnId }),
    ...(engine.state.currentAttemptId === undefined ? {} : { attemptId: engine.state.currentAttemptId }),
    streamIndex: engine.state.streamIndex,
    ...(engine.budget.contextTokenLimit === undefined ? {} : { contextTokenLimit: engine.budget.contextTokenLimit }),
    ...(request.maxOutputTokens === undefined ? {} : { explicitOutputAllowance: request.maxOutputTokens }),
  }));
}

/** The measured request owns both the live report and its one persistable
 * checkpoint. Missing usage preserves the prior report's original identity. */
export function recordPromptInputObservation(engine: Engine, observation: StreamObservation,
  measurement: PromptMeasurement, transcriptLength: number): void {
  engine.promptTokens = observation.usage.inputTokens;
  const completeInput = observation.inputTokenObservation;
  if (completeInput !== undefined || observation.usage.inputTokens > 0) engine.promptReport = {
    promptTokens: completeInput?.tokens ?? observation.usage.inputTokens,
    ...(completeInput === undefined ? {} : { inputTokenObservation: completeInput }),
    transcriptLength, measurement, windowId: engine.compaction.window?.windowId,
  };

  const stored = !observation.sawFinish || completeInput === undefined ? undefined
    : captureStoredInputBasis(measurement, completeInput);
  if (stored !== undefined && engine.state.sessionId !== undefined && engine.state.turnId !== undefined
    && engine.state.currentAttemptId !== undefined) engine.lastPromptInputCheckpoint = {
      version: 1, sessionId: engine.state.sessionId, turnId: engine.state.turnId,
      attemptId: engine.state.currentAttemptId, streamIndex: engine.state.streamIndex, basis: stored,
    };
}

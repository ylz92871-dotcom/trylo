import type { ReduceInput } from "../domain/input.js";
import { reduce } from "../domain/reduce.js";
import { initialState, type ExecutionState } from "../domain/state.js";

/**
 * Replaying an input log against the reducer.
 *
 * Recovery uses this to rebuild state from a journal: the inputs are facts that
 * already happened, so the only question is which of their effects were durably
 * committed. An effect whose key is already committed is reported as skipped
 * rather than re-issued, which is what makes a replay safe to run twice.
 */
export function replayCommitted(
  inputs: readonly ReduceInput[],
  committedKeys: ReadonlySet<string>,
): { state: ExecutionState; skipped: readonly string[] } {
  let state = initialState();
  const skipped: string[] = [];

  for (const input of inputs) {
    const result = reduce(state, input);
    if (result.ok) {
      state = result.state;
      for (const command of result.commands) {
        if (committedKeys.has(command.idempotencyKey)) {
          skipped.push(command.idempotencyKey);
        }
      }
    }
  }

  return { state, skipped };
}

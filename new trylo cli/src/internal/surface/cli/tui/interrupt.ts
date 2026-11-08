/**
 * The Ctrl-C state machine (work-package contract #4).
 *
 * Semantics, aligned with codex's cancellation behavior: the first interrupt
 * cancels the *current thing* — the running turn, or the input line being
 * typed — and the process stays alive; a second consecutive interrupt exits.
 * Any other key between two interrupts resets the count, so a stray Ctrl-C
 * an hour ago never makes the next one lethal.
 *
 * This module is a pure reducer. The IO shell feeds it interrupts and acts on
 * the action it returns. In this build the line adapter cannot observe
 * interrupts at all (only the composition root may touch `process`), so the
 * machine ships fully tested and dormant until the interrupt source is wired
 * — see OPEN-T2-2 in `T2-HANDOFF-MANIFEST.md`.
 */

export type InterruptPhase = "idle" | "running";

export type InterruptInput =
  | { readonly type: "interrupt"; readonly phase: InterruptPhase }
  | { readonly type: "key" };

export type InterruptAction =
  | { readonly kind: "none" }
  /** First interrupt while typing: drop the line, keep the process. */
  | { readonly kind: "clear_input"; readonly note: string }
  /** First interrupt during a turn: request the turn's cancellation. */
  | { readonly kind: "cancel_turn"; readonly note: string }
  /** Second consecutive interrupt: leave. */
  | { readonly kind: "exit" };

export type InterruptState = {
  readonly consecutive: number;
};

export const emptyInterruptState: InterruptState = { consecutive: 0 };

export function reduceInterrupt(
  state: InterruptState,
  input: InterruptInput,
): { readonly state: InterruptState; readonly action: InterruptAction } {
  if (input.type === "key") {
    return { state: { consecutive: 0 }, action: { kind: "none" } };
  }

  const consecutive = state.consecutive + 1;
  if (consecutive >= 2) {
    return { state: { consecutive }, action: { kind: "exit" } };
  }

  if (input.phase === "running") {
    return {
      state: { consecutive },
      action: {
        kind: "cancel_turn",
        note: "Ctrl-C: cancel requested for the current turn; press again to exit",
      },
    };
  }

  return {
    state: { consecutive },
    action: {
      kind: "clear_input",
      note: "Ctrl-C: input dropped; press again to exit",
    },
  };
}

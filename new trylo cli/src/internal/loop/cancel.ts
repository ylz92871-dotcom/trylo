import type { Engine } from "./runner-engine.js";

/**
 * The loop's cancellation, as a fact rather than an exception
 * (WP `2026-09-16-WP-传统CLI-交付面收尾波` D3).
 *
 * Two cancellations arrive at the loop and must mean the same thing:
 *
 *  - the caller's, raised through `RunTurnRequest.cancelSignal` (the surface's
 *    Ctrl-C, a parent process, whatever the host wants);
 *  - the loop's own, `engine.abort`, which the reducer's `cancel_provider`
 *    effect trips.
 *
 * Both are answered by the same state transition — the `cancel` input, ending
 * the turn `cancelled` and recording `user_cancel` — because a cancel is a
 * state the turn reaches, never a throw out of it. Nothing here mutates the
 * engine: `followCancellation` only *remembers* and cuts the stream, and the
 * loop applies the transition at its own boundary.
 *
 * This module exists apart from `runner.ts` so the runner keeps its frozen line
 * budget (the two size gates in `exec-substrate-discipline.test.ts` and
 * `method-line-budget.test.ts`); the discipline they enforce is "split something
 * out", not "widen the ceiling".
 */

/** True once the caller's cancellation has been raised. */
export type CancelWatch = () => boolean;

/**
 * Arms the caller's cancellation, if there is one, and answers whether it fired.
 *
 * Aborting does two things, in this order and for different reasons: the fact is
 * remembered so the loop applies the cancel *transition* at its next boundary
 * even when the stream it was cut out of ends quietly, and the provider stream
 * is cut so that boundary is reached now rather than after a stream nobody is
 * waiting for any more.
 *
 * The cut is gated on `streaming` deliberately. `engine.abort` is also the
 * signal a tool executes under, and aborting *that* would stop a write in flight
 * without going through `cancel_tool` — the half-written-workspace case the
 * reducer's own cancel path exists to avoid. A cancel raised while a tool runs
 * is applied at the boundary after it settles. In parallel, tool-cancellation
 * asks the active adapter to stop through ToolPort.cancel: process/MCP owners
 * can stop promptly, while atomic writes retain their original signal.
 */
export function followCancellation(signal: AbortSignal | undefined, engine: Engine): CancelWatch {
  if (signal === undefined) {
    return () => false;
  }

  let requested = false;
  const raise = (): void => {
    requested = true;
    if (engine.state.phase === "streaming") {
      engine.abort.abort();
    }
  };

  if (signal.aborted) {
    raise();
  } else {
    signal.addEventListener("abort", raise, { once: true });
  }

  return () => requested;
}

/**
 * Whether a cancellation is standing and there is still a turn to end.
 *
 * The phase is read on each call, through a call boundary: a `terminal` turn has
 * already decided its reason, and dispatching a second `cancel` into it would be
 * a late input rather than the transition we are trying to apply.
 */
export function cancellationStanding(watch: CancelWatch, engine: Engine): boolean {
  return engine.state.phase !== "terminal" && (watch() || engine.abort.signal.aborted);
}

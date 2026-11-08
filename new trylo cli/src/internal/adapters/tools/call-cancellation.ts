/**
 * Reaching a tool call that is already running.
 *
 * # The gap this closes
 *
 * `ToolPort.cancel(toolCallId)` existed and every mutating tool answered it with
 * an empty body — `mutating/index.ts` claimed a shell "holds nothing after its
 * timeout fires". That was true of the *result* and false of the *process*: the
 * loop dispatches `cancel_tool` when a turn is cancelled, so a user pressing
 * Ctrl-C during a long build produced a `cancel_tool` effect that cancelled
 * nothing. The turn ended `cancelled` while the build kept running, which is
 * exactly the defect the parity table names as "UI stopping is not the tool
 * stopping".
 *
 * # Why this does not fight the loop
 *
 * The loop deliberately does **not** cut a running tool's own signal: a write in
 * flight must be allowed to finish atomically (`cancel.ts` says so, and
 * `cancel-signal.test.ts` pins it). This registry is the second channel. It does
 * not touch `engine.abort`; it gives a tool an *extra* reason to stop, which the
 * tool may accept or decline. `write_file` and friends decline — they hold
 * nothing to stop. `run_shell` accepts, because it owns a process tree.
 *
 * So the ordering guarantee the loop cares about survives untouched: a cancel is
 * still applied as a state transition at a boundary, never thrown into a write.
 */

export type CallCancellationRegistry = {
  /** Start tracking a call. Returns the controller whose signal stops it. */
  begin(toolCallId: string): AbortController;
  /** Ask the call to stop; false means it was not running. */
  cancel(toolCallId: string): boolean;
  /** Forget a settled call. Safe to call twice. */
  end(toolCallId: string): void;
  /** Calls currently open, for a test or a teardown assertion. */
  readonly size: number;
};

export function createCallCancellationRegistry(): CallCancellationRegistry {
  const running = new Map<string, AbortController>();

  const abortQuietly = (controller: AbortController): void => {
    // Idempotent by contract: `AbortController.abort` is already safe to repeat,
    // and a stop may legitimately arrive twice (a cancel beside a timeout).
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  return {
    begin(toolCallId: string): AbortController {
      const controller = new AbortController();
      running.set(toolCallId, controller);
      return controller;
    },

    cancel(toolCallId: string): boolean {
      const controller = running.get(toolCallId);
      if (controller === undefined) {
        return false;
      }
      abortQuietly(controller);
      return true;
    },

    end(toolCallId: string): void {
      running.delete(toolCallId);
    },

    get size(): number {
      return running.size;
    },
  };
}

/**
 * A signal that fires when *either* the turn is cancelled or this call is
 * stopped.
 *
 * Two sources because they mean different things and the tool must react to
 * both: the turn's signal carries the loop's boundary discipline, and `own` is
 * the explicit "this call, now". They arrive at different moments, and a tool
 * watching only one would keep running when the other fired.
 *
 * The listener is removed on release so a settled call leaves nothing attached
 * to the turn's signal — otherwise every command would add a listener to a
 * signal that lives as long as the turn.
 */
export function linkedSignal(
  turnSignal: AbortSignal,
  own: AbortSignal,
): { readonly signal: AbortSignal; readonly release: () => void } {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  const sources: ReadonlyArray<AbortSignal> = [turnSignal, own];

  for (const source of sources) {
    if (source.aborted) {
      abort();
      continue;
    }
    source.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    release: () => {
      for (const source of sources) {
        source.removeEventListener("abort", abort);
      }
    },
  };
}

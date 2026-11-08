import { EXIT_CODES, type CliRunStatus } from "../../../protocol/cli-stream.js";
import type { CliContext } from "../context.js";
import {
  emptyInterruptState,
  reduceInterrupt,
  type InterruptAction,
  type InterruptPhase,
  type InterruptState,
} from "./interrupt.js";
import type { TuiIo } from "./io.js";

/**
 * The interrupt hub: where the pure Ctrl-C machine meets the shell.
 *
 * Actions land as facts the loop reads at its next boundary — never a second
 * thread, never a mid-await kill. Two of them also reach the turn in flight,
 * because a flag checked at a boundary cannot stop a stream that is already
 * open: the hub holds the current turn's `AbortController` and the cancel path
 * aborts it. That is the whole of what the live wiring adds — the ordering
 * guarantees stay the loop's, not the shell's.
 *
 * The second interrupt is the one deliberate exception to "no mid-await kill":
 * what is in flight may be a read (a permission prompt, a line being typed) that
 * no abort can return from, so the process is left from here — what codex and
 * cline do for their own exit key. When the context carries no way to leave (a
 * test that injected line IO only), the flag alone is set and the loop's own
 * exit path returns the same code.
 *
 * It lives beside `entry.ts` rather than inside it so the entry keeps its line
 * budget, the same discipline the loop's size gates enforce.
 */

export type InterruptHub = {
  readonly armed: boolean;
  machine: InterruptState;
  phase: InterruptPhase;
  cancelRequested: boolean;
  exitRequested: boolean;
  /** The turn in flight, so a cancel can reach a stream that is already open. */
  cancelTurn: AbortController | undefined;
  /**
   * Feed one interrupt through the machine from a non-signal source (WP23.2):
   * in raw mode the terminal does not deliver SIGINT, so the composer's
   * Ctrl-C arrives here as a key. Answers the action the machine chose, so
   * the caller can carry out the parts that belong to it (clearing the line).
   */
  readonly notify: () => InterruptAction;
};

export function interruptHubOf(io: TuiIo, ctx: CliContext): InterruptHub {
  const handle = (): InterruptAction => {
    const next = reduceInterrupt(hub.machine, { type: "interrupt", phase: hub.phase });

    hub.machine = next.state;

    if (next.action.kind === "cancel_turn") {
      hub.cancelRequested = true;
      hub.cancelTurn?.abort();
    }

    if (next.action.kind === "exit") {
      hub.exitRequested = true;
      hub.cancelTurn?.abort();
      ctx.interrupts?.exit(EXIT_CODES.CANCELLED);
    }

    return next.action;
  };
  const hub: InterruptHub = {
    armed: io.onInterrupt !== undefined,
    machine: emptyInterruptState,
    phase: "idle",
    cancelRequested: false,
    exitRequested: false,
    cancelTurn: undefined,
    notify: handle,
  };

  if (io.onInterrupt !== undefined) {
    io.onInterrupt(handle);
  }

  return hub;
}

/**
 * What to say after an interrupt asked for the turn to stop.
 *
 * The status decides, not the request: a turn that reached `cancelled` really
 * was stopped, and one that came back `completed` was not. Reporting "cancelled"
 * because somebody pressed Ctrl-C would be the shell describing what it asked
 * for instead of what happened.
 */
export function cancelNote(status: CliRunStatus): string {
  return status === "cancelled"
    ? "turn cancelled"
    : "cancel was requested during the turn; the turn finished before it could be stopped";
}

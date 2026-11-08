import type { AddressedUserInput } from "../../../domain/input-queue.js";
import type { ExitCode } from "../../../protocol/cli-stream.js";
import type { TurnOutcome } from "../host.js";
import { isRunFailure, type RunFailure, type RunScaffold } from "../run-command.js";
import type { CliSink } from "../render.js";
import { scaffoldAfterTurn } from "../turn-threading.js";
import { collectingSink } from "./event-wire.js";
import type { TuiIo } from "./io.js";
import { cancelNote, type InterruptHub } from "./interrupt-hub.js";
import type { MidRunInput } from "./mid-run-input.js";
import { createPainter, type Painter } from "./painter.js";
import { pushSystemLine, reduceTuiEvent, type TuiState } from "./state.js";
import type { TuiPaint } from "./theme.js";

/**
 * One turn of the shell (WP08).
 *
 * Split out of `entry.ts` because the entry is the shell's shape — startup, the
 * prompt loop, the slash table — and this is the one thing that happens inside
 * an iteration of it: hand the text to the run host, keep the frame current
 * while it runs, and say what became of every word the person said.
 *
 * What it owns and the entry does not: the painter for this turn, and the cancel
 * controller the interrupt hub reaches for. Both are per-turn objects, and both
 * are closed before this function returns.
 *
 * The reader is *not* per-turn, and that is the whole trick: a terminal line
 * source has no cancel, so a reader that started and stopped with each turn
 * would leave a read parked that the next prompt can never be served from. The
 * entry owns one reader for the session and lends it here for the duration of a
 * turn.
 *
 * The one promise it makes about words: none are dropped. What the turn took is
 * delivered; what it was handed and never delivered comes back out as
 * `leftover` for the prompt to run.
 */

/** The one turn executor. The default binds the real run host. */
export type TuiTurnRunner = (
  scaffold: RunScaffold,
  text: string,
  sink: CliSink,
  /**
   * Aborted when the person asks for this turn to stop. A runner is expected to
   * honour it; one that ignores it is not wrong, only unresponsive, and the
   * shell then says so instead of pretending the turn was stopped.
   */
  cancel: AbortSignal,
  /**
   * What the person typed while this turn was running (WP08). Absent — a runner
   * that cannot hear mid-run input, and every caller written before this
   * parameter — means the turn runs exactly as it always did.
   */
  pendingInput?: (turnId: string) => ReadonlyArray<AddressedUserInput>,
) => Promise<TurnOutcome | RunFailure>;

export type TurnStep = {
  readonly state: TuiState;
  readonly scaffold: RunScaffold;
  /**
   * Words this turn was handed and never delivered. They are the shell's to
   * hand back at the prompt: a turn that ended with words in its inbox does not
   * get to garbage-collect them.
   */
  readonly leftover: ReadonlyArray<string>;
} & ({ readonly kind: "continue" } | { readonly kind: "stop"; readonly exitCode: ExitCode });

export async function tuiTurn(
  io: TuiIo,
  runner: TuiTurnRunner,
  scaffold: RunScaffold,
  state: TuiState,
  input: string,
  hub: InterruptHub,
  paint: TuiPaint,
  painterRef: { current?: Painter | undefined },
  mid?: MidRunInput,
): Promise<TurnStep> {
  const before = state.lines.length;
  const notes: string[] = [];
  const painter = createPainter(io, before, paint);

  painterRef.current = painter;
  // The state is advanced as the events arrive, not once the turn is over: the
  // painter draws this, so what is on screen during a turn is the turn's own
  // state so far (WP D1/D3).
  let live = state;
  // One controller per turn, held by the hub for exactly this turn's duration:
  // an interrupt that arrives while it is open aborts it, and the host turns
  // that into the loop's own `cancel` transition. Nothing is killed — the turn
  // ends because it was told to.
  const cancelTurn = new AbortController();

  hub.cancelTurn = cancelTurn;
  /**
   * Lent the shell's one reader for this turn (WP08). Absent — a shell that
   * never opted in — the turn is handed no lender and runs exactly as it always
   * did, and the two hooks below are constructed and never called.
   */
  mid?.begin({
    onQueued: count => {
      live = { ...live, pendingInputCount: count };
      painter.request(live);
    },

    onTaken: (texts) => {
      live = { ...live, pendingInputCount: mid?.waiting() ?? 0 };
      live = pushSystemLine(
        live,
        texts.length === 1
          ? `taken into this turn: ${texts[0]}`
          : `taken into this turn: ${texts.length} messages`,
      );
      painter.request(live);
    },

    onRefused: (text, reason) => {
      live = pushSystemLine(live, `not taken (${reason}): ${text}`);
      painter.request(live);
    },
  });
  /**
   * End this turn's claim on the reader and collect every word it did not
   * answer. Words spoken from here on go back to the prompt, which is the only
   * reader that will be listening.
   */
  const closeReader = (): ReadonlyArray<string> => {
    if (mid === undefined) {
      return [];
    }
    return mid.end().map((item) => item.text);
  };
  let leftover: ReadonlyArray<string> = [];

  try {
    const outcome = await runner(
      scaffold,
      input,
      collectingSink(notes, (event) => {
        live = reduceTuiEvent(live, event, io.size().columns);
        painter.request(live);
      }),
      cancelTurn.signal,
      mid?.pendingInput,
    );

    hub.cancelTurn = undefined;
    leftover = closeReader();
    live = { ...live, pendingInputCount: 0 };

    // Two ways a turn can owe words, and both are the shell's debt now: what the
    // reader was holding when the turn ended, and what the loop had taken from
    // it and never reached a boundary it could promote at (WP08.3).
    if (isTurnOutcome(outcome)) {
      leftover = [...leftover, ...(outcome.unconsumedInput ?? []).map((input) => input.text)];
    }

    let next = live;

    // Said before anything else, because it is the one thing a person can act
    // on: their words did not disappear, they simply were not answered yet.
    for (const text of leftover) {
      next = pushSystemLine(next, `not delivered (the turn ended first): ${text}`);
    }

    for (const note of notes) {
      next = pushSystemLine(next, note);
    }

    if (!isTurnOutcome(outcome)) {
      next = pushSystemLine(next, outcome.message);
      next = pushSystemLine(next, outcome.hint);
      painter.settle(next);
      return outcome.continuation === "session_closed"
        ? { kind: "stop", state: next, scaffold, leftover, exitCode: outcome.exitCode }
        : { kind: "continue", state: next, scaffold, leftover };
    }

    for (const warning of outcome.warnings) {
      next = pushSystemLine(next, `warning: ${warning}`);
    }

    if (hub.cancelRequested) {
      hub.cancelRequested = false;
      next = pushSystemLine(next, cancelNote(outcome.result.status));
    }

    const threaded = await scaffoldAfterTurn(scaffold, outcome);
    if (isRunFailure(threaded)) {
      next = pushSystemLine(pushSystemLine(next, threaded.message), threaded.hint);
      painter.settle(next);
      return { kind: "stop", state: next, scaffold, leftover, exitCode: threaded.exitCode };
    }

    painter.settle(next);

    return { kind: "continue", state: next, scaffold: threaded, leftover };
  } finally {
    // A runner that threw must not leave the turn holding the reader: ending
    // twice is a no-op, so this is the safety net rather than the path.
    closeReader();
    painter.dispose?.();
    painterRef.current = undefined;
  }
}

function isTurnOutcome(value: TurnOutcome | RunFailure): value is TurnOutcome {
  return "result" in value;
}

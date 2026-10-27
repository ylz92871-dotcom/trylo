import { EXIT_CODES, type CliRunResult, type ExitCode } from "../../protocol/cli-stream.js";
import type { RunTurnResult } from "../../loop/runner.js";
import type { CompactWindow } from "../../ports/compaction.js";
import type { Transcript } from "../../protocol/transcript.js";
import type { AddressedUserInput } from "../../domain/input-queue.js";
import { exitCodeForResult, providerErrorClass, terminalStatusOf, UNREUSABLE_ERROR_CLASSES, usageToCli } from "./host-status.js";
import type { TurnFailure, TurnHostInput } from "./host.js";
import { persistTurnResult } from "./session-record.js";
import type { TurnRenderer } from "./render.js";
import type { TurnRecorder } from "./turn-recorder.js";

/**
 * Settling a turn that has already run.
 *
 * Split out of `host.ts` for the same reason `host-status.ts` was: that file had
 * reached the size discipline's ceiling, and the discipline's answer is to split
 * rather than to raise the ceiling. But the split is not only arithmetic — a turn
 * has two genuinely separate halves. `host.ts` decides *what this run is made of*
 * (ports, rules, permissions, budget); this file decides *what the run came to*
 * (whether the warm session survives, what it cost, what the user is shown, what
 * the journal keeps). A reader looking for "why did this exit 52" wants this file
 * and not the one that builds the tool table.
 */

/**
 * What a turn came to.
 *
 * It lives beside the finish rather than beside the host because it *is* the
 * answer the finish produces: this file decides what the run came to, and the
 * type is that decision's shape. `host.ts` re-exports it, so every caller that
 * has always named it there still does.
 */
export type TurnOutcome = {
  readonly exitCode: ExitCode;
  readonly result: CliRunResult;
  /**
   * The full transcript after the turn. A REPL feeds this back as the next
   * turn's resume transcript so the conversation keeps its history without
   * re-deriving it from the journal.
   */
  readonly transcript: Transcript;
  /**
   * The window the turn ended under, as the journal now holds it. A REPL feeds
   * it back too, alongside the journal it was read from, so the next turn keeps
   * the projected past instead of re-sending what a summary replaced.
   */
  readonly view: CompactWindow | undefined;
  readonly warnings: ReadonlyArray<string>;
  /** Canonical terminal provider class, kept for host retry/fallback decisions. */
  readonly providerErrorClass?: string;
  /**
   * Input the loop took and never promoted because the turn ended first (WP08.3)
   * — a debt, not a message. Absent means nothing was owed. See
   * `domain/input-queue.ts` for the contract both ends of it are written in.
   */
  readonly unconsumedInput?: ReadonlyArray<AddressedUserInput>;
};

/** What the finish needs from the turn it is settling. */
export type TurnFinishInput = {
  readonly recorder?: TurnRecorder;
  readonly result: RunTurnResult;
  readonly renderer: TurnRenderer;
  readonly input: TurnHostInput;
  readonly startedAt: number;
  readonly providerId: string;
  readonly model: string;
  /** What the MCP layer could not do, merged into the run's own warnings. */
  readonly extraWarnings: ReadonlyArray<string>;
};

/**
 * Close the turn: warm layer, cost, durable tail, final projection.
 *
 * Order matters and is the order written here. The warm entry is dropped *before*
 * the projection is closed. A durable tail is acknowledged before the final
 * result is rendered, so a failed write cannot print a completed result first.
 */
export async function finishTurn(finish: TurnFinishInput): Promise<TurnOutcome | TurnFailure> {
  const { result, input } = finish;
  const errorClass = providerErrorClass(result.envelopes);

  // A provider that just failed is not a provider to hand to the next turn. The
  // warm entry is dropped so the next turn rebuilds instead of reusing a session
  // whose endpoint or credential turned out not to work (D2: rebuild, never
  // pass an old state off as a live one). Rate limiting is deliberately *not* in
  // this set: the connection is fine, the quota is not, and rebuilding would
  // spend a handshake to learn the same thing.
  if (input.warm !== undefined && UNREUSABLE_ERROR_CLASSES.has(errorClass ?? "")) {
    input.warm.invalidateAll();
  }

  const durationMs = Math.max(0, input.now() - finish.startedAt);
  const usage = usageToCli(result.usage);
  const status = terminalStatusOf(result);
  const persisted = await persistTurnResult({ ...input, startedAtMs: finish.startedAt,
    ...(finish.recorder === undefined ? {} : { recorder: finish.recorder }),
  }, result, usage, status);
  const runResult = finish.renderer.close(
    result.transcript,
    usage,
    {
      sessionId: input.sessionId,
      turnId: input.turnId,
      providerId: finish.providerId,
      model: finish.model,
      iterations: result.iterations,
      durationMs,
    },
    { status, finishReason: result.state.finishReason },
  );

  return {
    exitCode: exitCodeForResult(result) as ExitCode,
    result: runResult,
    transcript: result.transcript,
    view: persisted.view,
    // What the MCP layer could not do is reported in the same channel as every
    // other run diagnostic, and *always* alongside a turn that still ran: a
    // server that did not come up is a smaller tool table, not a failed turn.
    warnings: [...persisted.warnings, ...finish.extraWarnings],
    ...(errorClass === undefined ? {} : { providerErrorClass: errorClass }),
    // A debt, not a message: words the person said and the turn never got to
    // use. Empty is the common case, and absent means the surface owes nothing
    // (WP08.3).
    ...(result.unconsumedInput.length === 0 ? {} : { unconsumedInput: result.unconsumedInput }),
  };
}

/**
 * A wiring that never became a turn.
 *
 * Named here rather than left in `host.ts` because it is a *finish* like any
 * other — the process is about to leave with a code and a hint — and because a
 * reader chasing exit 52 should find both shapes of that exit in one file.
 */
export function wiringFailure(detail: string): TurnFailure {
  return {
    exitCode: EXIT_CODES.CONFIG,
    message: detail,
    hint: "check `trylo config show` for the resolved endpoint and provider",
  };
}

import type { Envelope } from "../../protocol/envelope.js";
import type { CliRunResult, CliStreamEvent, CliUsage, CliRunStatus } from "../../protocol/cli-stream.js";
import type { Transcript } from "../../protocol/transcript.js";
import { projectEnvelopeSequence } from "./stream-projection.js";

/**
 * Core envelopes -> CLI stream events.
 *
 * The mapping itself — one envelope in, zero or more events out — lives in
 * `stream-projection.ts` and only there, so an incremental consumer and this
 * end-of-run projection cannot drift into two ideas of what happened. What
 * stays in this file is the part that genuinely needs the whole turn: the two
 * events that bracket it, and the fields read off the finished transcript.
 *
 * Fixture providers, real providers, the REPL and `run --format stream-json`
 * all go through here.
 */

export type RunResultMeta = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly providerId: string;
  readonly model: string;
  readonly iterations: number;
  readonly durationMs: number;
};

/**
 * The part of the meta that exists before the run does.
 *
 * `run_start` brackets the run rather than describing any core fact, so it is
 * the one event a host can emit before a turn has produced anything — and it
 * needs only these four facts to do it.
 */
export type RunStartFacts = {
  readonly contextWindow?: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly providerId: string;
  readonly model: string;
};

export type TerminalFacts = {
  readonly status: CliRunStatus;
  readonly finishReason: string;
};

/** Earlier replies cannot answer a newer user input, including a resumed turn
 * that failed before producing any assistant text or a mid-turn correction.
 */
export function lastMessageOf(transcript: Transcript): string {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.kind === "user") return "";
    if (item !== undefined && item.kind === "assistant_text") {
      return item.text;
    }
  }
  return "";
}

export function projectRunStart(meta: RunStartFacts): CliStreamEvent {
  return {
    type: "run_start",
    sessionId: meta.sessionId,
    turnId: meta.turnId,
    providerId: meta.providerId,
    model: meta.model,
    ...(meta.contextWindow === undefined ? {} : { contextWindow: meta.contextWindow }),
  };
}

/**
 * Envelope-derived events, in the order the turn produced them.
 *
 * This is the batch face of the one translator: it is exactly what a host gets
 * by pushing the same envelopes through `createStreamTranslator` as they
 * arrive, drained once at the end. Keeping the two identical is the whole point
 * (WP D2) — the incremental path is allowed to deliver events *earlier* and
 * nothing else.
 *
 * `run_start` and `run_result` are not here: they bracket the run rather than
 * describe a core fact, so the host emits them.
 */
export function projectEnvelopes(envelopes: ReadonlyArray<Envelope>): ReadonlyArray<CliStreamEvent> {
  return projectEnvelopeSequence(envelopes);
}

export function projectRunResult(
  transcript: Transcript,
  usage: CliUsage,
  meta: RunResultMeta,
  terminal: TerminalFacts,
): CliRunResult {
  return {
    type: "run_result",
    status: terminal.status,
    finishReason: terminal.finishReason,
    sessionId: meta.sessionId,
    turnId: meta.turnId,
    iterations: meta.iterations,
    usage,
    durationMs: meta.durationMs,
    lastMessage: lastMessageOf(transcript),
  };
}

export function projectRun(
  envelopes: ReadonlyArray<Envelope>,
  transcript: Transcript,
  usage: CliUsage,
  meta: RunResultMeta,
  terminal: TerminalFacts,
): ReadonlyArray<CliStreamEvent> {
  return [
    projectRunStart(meta),
    ...projectEnvelopes(envelopes),
    projectRunResult(transcript, usage, meta, terminal),
  ];
}

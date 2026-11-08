import type { Envelope } from "../protocol/envelope.js";
import type { StreamPartials } from "../protocol/stream-partial.js";
import type { Transcript, TranscriptItem } from "../protocol/transcript.js";
import type { PromptInputCheckpoint } from "./prompt-input.js";

/** Closed canonical facts only; partial provider fragments are not messages. */
export type ExecutionProgress = {
  readonly transcript: Transcript;
  readonly envelopes: ReadonlyArray<Envelope>;
  /** Private metadata belongs only to its matching accepted stream_end append. */
  readonly promptInputCheckpoint?: PromptInputCheckpoint;
};

export type ExecutionEffectOutcome = Extract<TranscriptItem, { kind: "tool_result" }>["outcome"];

export type ProgressWriteOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string };

/**
 * An awaited execution boundary, unlike an envelope observer.
 *
 * The host supplies one writer per turn. flush accepts canonical facts already
 * owned by execution; it must persist only new items. issue must acknowledge
 * durability before a tool begins. settle follows a durable tool result; an
 * unknown outcome stays unresolved. Absent means the historical library path.
 * Failure stops the run; callers must never retry an effect from a missing ack.
 */
export type ExecutionProgressPort = {
  flush(progress: ExecutionProgress): Promise<ProgressWriteOutcome>;
  issue(key: string): Promise<ProgressWriteOutcome>;
  settle(key: string, outcome: ExecutionEffectOutcome): Promise<ProgressWriteOutcome>;
  /**
   * Durably records blocks that are still open, as they grow.
   *
   * The awaited counterpart to `flush`: where `flush` persists what has
   * *closed*, this persists what has not yet. It is what makes a process killed
   * mid-stream leave the text the model had already produced on disk instead of
   * in memory. Nothing here can make a partial into an answer — a preserved
   * block is never replayed to a model and, for `tool_input`, never becomes a
   * call.
   *
   * Absent means the caller runs without in-flight durability, exactly as it
   * did before this method existed.
   */
  preserve?(partials: StreamPartials): Promise<ProgressWriteOutcome>;
};

/** Stable boundary failure, caught by the CLI host without parsing OS text. */
export class ExecutionProgressError extends Error {
  constructor(readonly stage: string, readonly code: string) {
    super(`execution_progress_failed:${stage}:${code}`);
    this.name = "ExecutionProgressError";
  }
}

import type { JsonObject } from "./envelope.js";
import { redactJsonValue } from "./redact.js";

/**
 * A provider block that was opened and never closed.
 *
 * A stream can be cut at any byte — a transport failure, a cancel, a process
 * killed mid-flight. Everything the model had already produced up to that cut
 * is real, but it is *not* an answer: the block never closed, so it cannot
 * enter the transcript (a resume would replay half a sentence as if the model
 * had finished saying it) and it cannot be executed (a tool call whose
 * arguments were never completed is not a call).
 *
 * So it gets its own canonical type, written as it arrives. Three properties
 * are the whole contract:
 *
 *  - **It is a prefix, never a completion.** Absence of a closing event is
 *    exactly what makes it a partial. There is no `closed` field: a block that
 *    closed stopped being a partial and became a transcript item.
 *  - **It never reaches the prompt.** `recover` keeps partials beside the
 *    transcript, not inside it, so a resume can *show* them without ever
 *    sending them to a model.
 *  - **It is append-only.** The record codec retains a V1 redacted snapshot
 *    followed by checked V2 suffixes, scoped by turn and block identity.
 *    Recovery reconstructs a snapshot; nothing rewrites durable history.
 */

export const STREAM_PARTIAL_FORMAT_VERSION = "1";

export const STREAM_PARTIAL_KINDS = [
  "assistant_text",
  "assistant_reasoning",
  "tool_input",
] as const;

export type StreamPartialKind = (typeof STREAM_PARTIAL_KINDS)[number];

/**
 * The identity a partial is folded by: two records with the same kind and
 * block id are the same block at two different moments, not two blocks.
 */
export type StreamPartialId = {
  readonly kind: StreamPartialKind;
  readonly blockId: string;
};

export type StreamPartial = StreamPartialId & {
  /** The bytes received so far. Redacted on the way to disk, never after. */
  readonly text: string;
  /** `tool_input` only: which tool the fragments were addressed to. */
  readonly name?: string;
  /** `assistant_reasoning` only: the provider marked the block redacted. */
  readonly redacted?: boolean;
};

export type StreamPartials = ReadonlyArray<StreamPartial>;

/**
 * The sanitised, JSON-proven form of one partial.
 *
 * Text crosses the same redaction boundary every other persisted value does,
 * and it is round-tripped through JSON here so what the store writes is
 * provably the shape `isStreamPartial` will later accept — not a cast.
 */
export function streamPartialPayload(partial: StreamPartial): JsonObject {
  const payload: JsonObject = {
    version: STREAM_PARTIAL_FORMAT_VERSION,
    kind: partial.kind,
    blockId: partial.blockId,
    text: redactJsonValue(partial.text) as string,
    ...(partial.name === undefined ? {} : { name: partial.name }),
    ...(partial.redacted === undefined ? {} : { redacted: partial.redacted }),
  };
  return JSON.parse(JSON.stringify(payload)) as JsonObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Runtime validation at the persistence read boundary.
 *
 * Fails closed on anything unrecognised: a `stream_partial` record whose
 * payload is not a partial is corruption (a writer bug, or a tamper that
 * recomputed the line checksum) and must never be projected into a
 * `StreamPartial` by shape alone.
 */
export function isStreamPartial(value: unknown): value is StreamPartial {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.kind !== "string" || !(STREAM_PARTIAL_KINDS as readonly string[]).includes(value.kind)) {
    return false;
  }
  if (typeof value.blockId !== "string" || value.blockId.length === 0) {
    return false;
  }
  if (typeof value.text !== "string") {
    return false;
  }
  if (value.kind === "tool_input" && typeof value.name !== "string") {
    return false;
  }
  if (value.kind === "assistant_reasoning" && typeof value.redacted !== "boolean") {
    return false;
  }
  return true;
}

/** One block's fold key: a compound value, so no separator can be forged. */
export function partialKey(partial: StreamPartialId, turnId?: string): string {
  return JSON.stringify([turnId ?? null, partial.kind, partial.blockId]);
}

/** True when both name the same block, so a newer record supersedes the older. */
export function samePartial(a: StreamPartialId, b: StreamPartialId): boolean {
  return a.kind === b.kind && a.blockId === b.blockId;
}

/**
 * Keeps the newest record per block, in the order the blocks were first seen.
 *
 * Folded records describe snapshots; only the newest is the block's current
 * content. Record-level V2 suffix validation happens before this projection.
 */
export function latestPartials(records: StreamPartials): StreamPartials {
  const latest = new Map<string, StreamPartial>();
  for (const partial of records) {
    latest.set(partialKey(partial), partial);
  }
  return [...latest.values()];
}

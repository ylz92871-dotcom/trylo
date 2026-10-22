import type { JsonObject } from "../protocol/envelope.js";
import type { StreamPartial } from "../protocol/stream-partial.js";
import type { Transcript } from "../protocol/transcript.js";

/**
 * Durable session contract.
 *
 * The journal is the authoritative source for resuming after exit. Projections
 * (text, stream-json, future TUI) read it; only the session store writes it.
 */

export const SESSION_FORMAT_VERSION = "1";

/** Records that may appear in the append-only journal. */
export const SESSION_RECORD_TYPES = [
  "session_start",
  "turn_start",
  "iteration_start",
  "turn_input",
  "transcript_item",
  "envelope",
  "effect_issued",
  "effect_committed",
  "effect_failed",
  "effect_unknown",
  "terminal",
  "compact",
  /**
   * A provider block that was opened and never closed: the durable form of an
   * in-flight chunk. Added in format v1 without renumbering it — readers of
   * older journals simply never meet one, and `recover` treats an absent
   * partial list as empty rather than as a different format. The payload codec
   * also supports V2 suffixes: old readers fail closed on that payload rather
   * than treating its suffix as a full snapshot. Existing V1 journals stay readable.
   */
  "stream_partial",
] as const;

export type SessionRecordType = (typeof SESSION_RECORD_TYPES)[number];

export type SessionRecord = {
  readonly formatVersion: string;
  /** Monotonic, gap-free. A gap means corruption, not a missing event. */
  readonly sequence: number;
  readonly type: SessionRecordType;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly iteration?: number;
  readonly at: string;
  readonly payload: JsonObject;
};

export type RuntimeFingerprint = {
  readonly schemaVersion: string;
  readonly providerId: string;
  readonly model: string;
  readonly toolCatalogHash: string;
  readonly workspaceId: string;
};

/**
 * Runtime validation for a fingerprint read back from the journal. A payload
 * is JSON at the persistence boundary; without this check a `session_start`
 * record could project an arbitrary object into `RuntimeFingerprint`.
 */
export function isRuntimeFingerprint(value: unknown): value is RuntimeFingerprint {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.schemaVersion === "string" &&
    typeof candidate.providerId === "string" &&
    typeof candidate.model === "string" &&
    typeof candidate.toolCatalogHash === "string" &&
    typeof candidate.workspaceId === "string"
  );
}

export type SessionStartInput = {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly fingerprint: RuntimeFingerprint;
};

export type RecoveryOutcome =
  | { readonly ok: true; readonly session: RecoveredSession }
  | { readonly ok: false; readonly code: RecoveryFailureCode; readonly detail: string };

export type RecoveryFailureCode =
  | "missing_session"
  | "lock_conflict"
  | "unknown_format_version"
  | "sequence_gap"
  | "checksum_mismatch"
  | "mid_file_corruption"
  | "fingerprint_mismatch";

/**
 * One issued-but-unsettled effect, addressed exactly.
 *
 * A key alone is not an address: the same tool call id can legitimately be
 * issued again in a later turn, so "settle `tool:c`" is ambiguous and could
 * resolve the wrong one. The journal sequence of the `effect_issued` record is
 * the only locator that is unique per issue, and the turn it belongs to is what
 * a settlement must carry for the fold to recognise it.
 */
export type PendingEffect = {
  /** Absent on journals written before turns carried one. */
  readonly turnId?: string;
  readonly key: string;
  /** The `effect_issued` record's journal sequence: unique, never reused. */
  readonly issuedAtSequence: number;
  readonly issuedAt: string;
};

export type RecoveredSession = {
  readonly sessionId: string;
  readonly fingerprint: RuntimeFingerprint;
  readonly transcript: Transcript;
  readonly lastSequence: number;
  /** Effects issued without a matching commit: real but outcome-unknown. */
  readonly reconcileRequired: ReadonlyArray<string>;
  /** The same effects, addressed: what a reconciliation must name. */
  readonly pendingEffects: ReadonlyArray<PendingEffect>;
  /**
   * Blocks that were opened and never closed, newest record per block.
   *
   * Deliberately *not* part of `transcript`: a half-received answer is not an
   * answer, and folding it into the history would replay it to the model as
   * one. Absent-looking (empty) for every journal written before this type
   * existed, so an old session recovers byte-identically.
   */
  readonly partials: ReadonlyArray<StreamPartial>;
  /** True when a torn tail was repaired under the documented rule only. */
  readonly repairedTornTail: boolean;
};

/**
 * The journal as written, including the bookkeeping records that `read`
 * collapses into a `RecoveredSession`. Compaction needs every record: a window
 * has to be able to point at sequences that carry no transcript item at all.
 *
 * Read-only by construction — it observes, never takes or releases the lock.
 */
export type SessionRecordView = {
  readonly records: ReadonlyArray<SessionRecord>;
  /** True when an unterminated final line was present and left in place. */
  readonly tornTail: boolean;
};

export type SessionRecordViewOutcome =
  | { readonly ok: true; readonly view: SessionRecordView }
  | { readonly ok: false; readonly code: RecoveryFailureCode; readonly detail: string };

export type SessionPort = {
  start(input: SessionStartInput): Promise<{ ok: true } | { ok: false; code: string }>;
  /**
   * Takes the single-writer lock on an existing session without appending a
   * `session_start` record. Resuming must never rewrite session identity, so
   * this is deliberately separate from `start`.
   */
  attach(): Promise<{ ok: true } | { ok: false; code: string }>;
  append(record: Omit<SessionRecord, "formatVersion" | "sequence">): Promise<{ ok: true; sequence: number } | { ok: false; code: string }>;
  /**
   * Drops an unterminated final line — the only repair the format permits.
   * Every other defect must fail closed, so this is never called implicitly by
   * `read`.
   */
  repairTornTail(): Promise<{ ok: true; removedBytes: number } | { ok: false; code: string }>;
  read(): Promise<RecoveryOutcome>;
  readRecords(): Promise<SessionRecordViewOutcome>;
  release(): Promise<void>;
};

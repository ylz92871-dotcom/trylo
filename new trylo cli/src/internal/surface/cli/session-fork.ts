import { recover } from "../../adapters/session-store/recovery.js";
import type { ForkProvenance } from "../../adapters/session-store/session-meta.js";
import { collectWindows } from "../../compaction/window.js";
import type { CompactWindow } from "../../ports/compaction.js";
import { isTranscriptItem } from "../../protocol/transcript.js";
import type { SessionRecord } from "../../ports/session.js";

/**
 * WP02.2 fork planner: which settled prefix of a parent journal may start a
 * child session.
 *
 * Pure on purpose — it reads decoded parent records and returns either the
 * records to append after the child's own `session_start`, or a refusal with
 * a code the CLI reports verbatim. The unsettled-effect fold is reused from
 * `recover` (the WP01 reader), so there is exactly one implementation of
 * "what is still unknown", shared rather than reimplemented.
 *
 * Three snapshot modes, borrowed from the Codex `ForkSnapshot` semantics and
 * the old CLI's branch copy, minus their runtimes:
 * - `settled-prefix`: the whole journal, but only when no effect is unfinished.
 *   Half-received stream blocks are display debris, not actions: they are
 *   dropped and counted (a live run always leaves some), never a refusal.
 * - `interrupted`: the whole journal minus the unfinished suffix (unsettled
 *   effects and half-received partials are dropped and counted, never copied).
 * - `before-user-message n`: the prefix strictly before the nth user message
 *   (1-based, as a person counts), with the same drop rule as `interrupted`.
 *
 * The parent journal is never modified here; the caller writes the plan into
 * a new session file that takes its own writer lock.
 */

export type ForkSnapshotRequest =
  | { readonly mode: "settled-prefix" }
  | { readonly mode: "interrupted" }
  | { readonly mode: "before-user-message"; readonly n: number };

export type ForkPlanInput = {
  readonly records: ReadonlyArray<SessionRecord>;
  readonly tornTail: boolean;
  readonly snapshot: ForkSnapshotRequest;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly at: string;
};

export type ForkPlan =
  | {
    readonly ok: true;
    /** Records to append after the child's own `session_start`, under the child id. */
    readonly records: ReadonlyArray<Omit<SessionRecord, "formatVersion" | "sequence">>;
    readonly provenance: ForkProvenance;
  }
  | {
    readonly ok: false;
    readonly code: "torn_tail" | "parent_unreadable" | "unsettled_effects" | "message_not_found";
    readonly detail: string;
  };

type Refusal = Extract<ForkPlan, { readonly ok: false }>;

function refuse(code: Refusal["code"], detail: string): Refusal {
  return { ok: false, code, detail };
}

function snapshotName(snapshot: ForkSnapshotRequest): ForkProvenance["snapshot"] {
  switch (snapshot.mode) {
    case "settled-prefix":
      return "settled-prefix";
    case "interrupted":
      return "interrupted";
    case "before-user-message":
      return "before-user-message";
  }
}

export function planFork(input: ForkPlanInput): ForkPlan {
  if (input.tornTail) {
    return refuse("torn_tail", "the parent journal grew a torn tail mid-read; repair or reconcile it first, then fork again");
  }

  if (input.records.length === 0 || input.records[0]?.type !== "session_start") {
    return refuse("parent_unreadable", "the parent journal has no session_start and cannot be a fork source");
  }

  let cut = input.records.length;
  let beforeUserMessage: number | undefined;

  if (input.snapshot.mode === "before-user-message") {
    const located = locateUserMessage(input.records, input.snapshot.n);
    if (!located.ok) {
      return located.refusal;
    }
    cut = located.cut;
    beforeUserMessage = input.snapshot.n;
  }

  const prefix = input.records.slice(0, cut);
  const recovered = recover(prefix, false);
  if (!recovered.ok) {
    return refuse("parent_unreadable", `the parent prefix does not recover: ${recovered.code}`);
  }

  const scanned = collectWindows(prefix);
  if (!scanned.ok) {
    return refuse("parent_unreadable", `the parent prefix does not project: ${scanned.code}`);
  }

  const pendingSequences = new Set(recovered.session.pendingEffects.map(effect => effect.issuedAtSequence));
  let droppedPartials = 0;
  let droppedPending = 0;
  const copied: Array<Omit<SessionRecord, "formatVersion" | "sequence">> = [];
  const retainedSequences = [prefix[0]!.sequence];

  for (const [index, record] of prefix.entries()) {
    if (index === 0) {
      continue;
    }

    if (record.type === "stream_partial") {
      droppedPartials += 1;
      continue;
    }

    if (record.type === "effect_issued" && pendingSequences.has(record.sequence)) {
      droppedPending += 1;
      continue;
    }

    const { formatVersion: _format, sequence: _sequence, ...rest } = record;

    copied.push({ ...rest, sessionId: input.childSessionId });
    retainedSequences.push(record.sequence);
  }

  if (input.snapshot.mode === "settled-prefix" && droppedPending > 0) {
    return refuse(
      "unsettled_effects",
      `${droppedPending} unsettled effect(s) still open; \`session reconcile\` the parent first, or fork with --interrupted to leave the unfinished suffix behind`,
    );
  }

  const rebased = rebaseCompactWindows(copied, retainedSequences, scanned.windows);
  if (!rebased.ok) return rebased;

  return {
    ok: true,
    records: rebased.records,
    provenance: {
      parentSessionId: input.parentSessionId,
      parentLastSequence: input.records[input.records.length - 1]?.sequence ?? 0,
      snapshot: snapshotName(input.snapshot),
      at: input.at,
      droppedPending,
      droppedPartials,
      copiedRecords: copied.length,
      ...(beforeUserMessage === undefined ? {} : { beforeUserMessage }),
    },
  };
}

/** First retained record at or after a parent journal boundary. Its index is
 * exactly the new child journal sequence, including the child's session_start. */
function childBoundary(retainedSequences: readonly number[], parentBoundary: number): number {
  let from = 0;
  let to = retainedSequences.length;

  while (from < to) {
    const middle = from + Math.floor((to - from) / 2);
    if (retainedSequences[middle]! < parentBoundary) from = middle + 1;
    else to = middle;
  }

  return from;
}

function rebaseCompactWindows(
  records: readonly Omit<SessionRecord, "formatVersion" | "sequence">[],
  retainedSequences: readonly number[],
  windows: readonly CompactWindow[],
): { readonly ok: true; readonly records: typeof records } | Refusal {
  const rebased: Array<Omit<SessionRecord, "formatVersion" | "sequence">> = [];
  let windowIndex = 0;

  for (const [index, record] of records.entries()) {
    if (record.type !== "compact") {
      rebased.push(record);
      continue;
    }

    const window = windows[windowIndex++];
    if (window === undefined) return refuse("parent_unreadable", "a compact record has no validated window");

    // The endpoints may themselves be discarded partials. Map the inclusive
    // range to its first/last retained records, rather than subtracting one
    // global deletion count or changing transcript/opaque provider payloads.
    const replacedFromSequence = childBoundary(retainedSequences, window.replacedFromSequence);
    const replacedToSequence = childBoundary(retainedSequences, window.replacedToSequence + 1) - 1;
    if (replacedFromSequence > replacedToSequence || replacedToSequence >= index + 1) {
      return refuse("parent_unreadable", "a compact range has no retained history before its child record");
    }

    rebased.push({ ...record, payload: { ...window, replacedFromSequence, replacedToSequence } });
  }

  return { ok: true, records: rebased };
}

function locateUserMessage(
  records: ReadonlyArray<SessionRecord>,
  n: number,
): { readonly ok: true; readonly cut: number } | { readonly ok: false; readonly refusal: Refusal } {
  let seen = 0;

  for (const [index, record] of records.entries()) {
    if (record.type !== "transcript_item") {
      continue;
    }

    if (!isTranscriptItem(record.payload)) {
      return { ok: false, refusal: refuse("parent_unreadable", `transcript payload at sequence ${record.sequence} is not a transcript item`) };
    }

    if (record.payload.kind !== "user") {
      continue;
    }

    seen += 1;

    if (seen === n) {
      return { ok: true, cut: index };
    }
  }

  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, refusal: refuse("message_not_found", `message index must be a positive integer, got ${String(n)}`) };
  }

  return {
    ok: false,
    refusal: refuse("message_not_found", `user message ${n} out of range (this session has ${seen}, numbered 1-${seen})`),
  };
}

import type { CompactRecordDraft, CompactWindow } from "../ports/compaction.js";
import {
  SESSION_FORMAT_VERSION,
  type SessionRecord,
  type SessionRecordType,
} from "../ports/session.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { Transcript } from "../protocol/transcript.js";

/**
 * What this turn knows about compaction, and the journal view it is derived from.
 *
 * Split out of `compact-boundary.ts` (WP §4: the main file stays under 400 lines)
 * along the seam that already existed: everything here is about *the state of
 * the ledger and the records it implies*, while `compact-boundary.ts` is about
 * *the decision to compact and what the model then sees*. The dependency runs
 * one way — the decision module imports the ledger module, never the reverse —
 * so there is no cycle to reason about.
 *
 * Two invariants live here and are the reason this is not folded back:
 *
 *  - the ledger is the only place a stored window is remembered, and it is
 *    never persisted; the journal is derived from it on every call;
 *  - the derivation is a pure function of (session id, transcript, entries), so
 *    two readers of the same turn cannot disagree about which records exist.
 */

/** The derived read model is never persisted, so it carries no real time. */
const VIEW_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/**
 * One stored window, plus where it sits.
 *
 * `afterItemCount` is the transcript length at the moment the window was
 * stored: that is exactly the position its record occupies in an append-only
 * journal, and it is what lets the journal view stay derived instead of copied.
 */
export type CompactionEntry = {
  readonly draft: CompactRecordDraft;
  readonly afterItemCount: number;
};

/**
 * The window a resumed turn arrives already covered by, in *this* numbering.
 *
 * A stored window speaks journal sequences. The decision journal below speaks
 * this module's own space, `session_start` at 0 and item `k` at `k + 1`.
 * Re-expressing it once here is what lets the gap decision compare a new window
 * against the one on record instead of starting at `session_start` again and
 * claiming history a summary already replaced.
 */
export type ResumedCompaction = {
  readonly window: CompactWindow;
  readonly afterItemCount: number;
};

export type CompactionLedger = {
  readonly entries: CompactionEntry[];
  /**
   * How many leading transcript items the newest window replaced. The live tail
   * is the transcript past that point, so the runner's own transcript stays the
   * authority on what was said while the model sees only the tail.
   */
  replacedPrefix: number;
  /**
   * The window the model's history has been collapsed into, if any. Undefined
   * means "send the transcript whole", which is also the un-wired case.
   */
  window: CompactWindow | undefined;
  /** The resumed turn's window, held in this numbering. Undefined when not resuming. */
  resumed: ResumedCompaction | undefined;
  /** Refused/ineffective authoring latches the current pressure episode.
   * A fresh final-request forecast below the trigger rearms it for new growth. */
  attempted: boolean;
};

export function createCompactionLedger(): CompactionLedger {
  return {
    entries: [],
    replacedPrefix: 0,
    window: undefined,
    resumed: undefined,
    attempted: false,
  };
}

/**
 * Adopts the window a durable session was stored under.
 *
 * A resumed conversation arrives already covered by a window, so the model
 * keeps seeing the projected past across a restart: without this the replaced
 * text would come back on every resume, which is the read half of the
 * compaction contract going missing.
 *
 * The prefix is read off the journal, not guessed: counting the `transcript_item`
 * records the upper bound covers gives exactly how many leading items the window
 * stands in for. A window that stands in for none of them is not adopted at all:
 * there is no journal to anchor the bounds to, and a digest over a transcript
 * nobody replaced invents a past.
 */
export function adoptResumedWindow(
  ledger: CompactionLedger,
  window: CompactWindow | undefined,
  records: ReadonlyArray<SessionRecord> | undefined,
  transcript?: Transcript,
): void {
  if (window === undefined || records === undefined) {
    return;
  }

  const replaced = livePrefixBefore(window, records, transcript);
  if (replaced === 0) {
    return;
  }

  ledger.window = window;
  ledger.replacedPrefix = replaced;
  ledger.resumed = {
    window: { ...window, replacedFromSequence: 0, replacedToSequence: replaced },
    afterItemCount: replaced,
  };
}

/**
 * A window authored in this numbering, re-expressed against the journal.
 *
 * Two numbering spaces meet in this module and nowhere else. This one numbers
 * `session_start` 0 and the transcript items after it — that is what makes an
 * in-memory window comparable with the items the next one would cover. The
 * durable journal numbers *every* record it holds, `turn_start`, envelopes,
 * effect rows and terminals included, so the two agree only by accident and a
 * stored bound drifts by however much bookkeeping precedes it. The loop is the
 * only place that knows both directions, so both live here: a stored window is
 * re-expressed into this numbering when it is adopted, and a window this turn
 * decided in its own numbering is re-expressed onto the journal — by the host,
 * which holds it — before it is appended.
 *
 * Match each source item through its own `sequence`, rather than assuming the
 * projected position is its ordinal: read-time purge can leave ordinal gaps.
 * Callers without a source view retain the legacy contiguous-ordinal mapping.
 */
export function windowOnJournal(
  window: CompactWindow,
  records: ReadonlyArray<SessionRecord>,
  source?: ReadonlyArray<SessionRecord>,
): CompactWindow | undefined {
  if (source !== undefined) return mapSourceWindow(window, source, records);

  // `replacedFromSequence` 0 is `session_start`, which carries no item, so the
  // first ordinal a window can cover is `-1` — excluded by the comparison below
  // without a special case.
  const from = window.replacedFromSequence - 1;
  const to = window.replacedToSequence - 1;
  let first: number | undefined;
  let last: number | undefined;

  for (const record of records) {
    const ordinal = transcriptOrdinal(record);
    if (ordinal === undefined || ordinal < from || ordinal > to) {
      continue;
    }

    if (first === undefined) {
      first = record.sequence;
    }

    last = record.sequence;
  }

  if (first === undefined || last === undefined) {
    return undefined;
  }

  return { ...window, replacedFromSequence: first, replacedToSequence: last };
}

/** Match canonical ordinals, never assume projected item positions equal them. */
function mapSourceWindow(window: CompactWindow, source: ReadonlyArray<SessionRecord>, records: ReadonlyArray<SessionRecord>): CompactWindow | undefined {
  const covered = source.filter(record => record.sequence >= window.replacedFromSequence && record.sequence <= window.replacedToSequence);
  const ordinals = new Set(covered.map(transcriptOrdinal).filter(ordinal => ordinal !== undefined));
  const matched = records.filter(record => {
    const ordinal = transcriptOrdinal(record);
    return ordinal !== undefined && ordinals.has(ordinal);
  });
  if (ordinals.size === 0 || matched.length !== ordinals.size) return undefined;

  return { ...window, replacedFromSequence: matched[0]!.sequence, replacedToSequence: matched[matched.length - 1]!.sequence };
}

/** The ordinal a journal record carries, when it carries a transcript item at all. */
function transcriptOrdinal(record: SessionRecord): number | undefined {
  if (record.type !== "transcript_item") {
    return undefined;
  }
  const sequence = record.payload["sequence"];
  return typeof sequence === "number" && Number.isInteger(sequence) ? sequence : undefined;
}

/** How many journal items the window's upper bound cuts off. */
function livePrefixBefore(
  window: CompactWindow,
  records: ReadonlyArray<SessionRecord>,
  transcript?: Transcript,
): number {
  if (transcript !== undefined) {
    const ordinals = new Set(records.filter(record => record.sequence <= window.replacedToSequence).map(transcriptOrdinal));
    return transcript.filter(item => ordinals.has(item.sequence)).length;
  }

  let count = 0;

  for (const record of records) {
    if (record.type !== "transcript_item" || record.sequence > window.replacedToSequence) {
      continue;
    }
    count += 1;
  }

  return count;
}

/**
 * The journal the port reads, derived on every call — never copied.
 *
 * The loop holds an in-memory transcript while the port speaks append-only
 * records whose sequence space is shared by transcript items and compact
 * records. Deriving keeps one source of truth, and a window sits at the
 * position it was stored at, so items appended afterwards only ever get later
 * sequences: every window already stored keeps the bounds it was issued with,
 * which is precisely what `collectWindows` demands.
 *
 * Sequence 0 is reserved for `session_start`; items occupy consecutive source
 * positions with stored window records inserted between them. Their canonical
 * ordinals may have gaps after read-time purge and are never renumbered. A bound
 * authored here speaks source record positions, so the host translates it by
 * matching source items to durable ordinals before persisting a fresh window.
 */
export function journalView(
  sessionId: string,
  transcript: Transcript,
  entries: ReadonlyArray<CompactionEntry>,
  resumed?: ResumedCompaction,
): ReadonlyArray<SessionRecord> {
  const windowsAt = new Map<number, unknown[]>();

  // The window the turn resumed under comes first: it was stored before any
  // window this turn can store, and windows must strictly advance.
  if (resumed !== undefined) {
    windowsAt.set(resumed.afterItemCount, [resumed.window]);
  }

  for (const entry of entries) {
    const queued = windowsAt.get(entry.afterItemCount) ?? [];
    windowsAt.set(entry.afterItemCount, [...queued, entry.draft.payload]);
  }

  const records: SessionRecord[] = [viewRecord(0, "session_start", sessionId, {})];
  let sequence = 1;

  // One step past the end: a window stored after the newest item still belongs
  // to the journal, and this is the only place it can be emitted.
  for (let itemCount = 0; itemCount <= transcript.length; itemCount += 1) {
    for (const draft of windowsAt.get(itemCount) ?? []) {
      const payload = asJsonObject(draft);
      if (payload === undefined) {
        continue;
      }
      records.push(viewRecord(sequence, "compact", sessionId, payload));
      sequence += 1;
    }

    const item = transcript[itemCount];
    if (item !== undefined) {
      const payload = asJsonObject(item);
      if (payload === undefined) {
        continue;
      }
      records.push(viewRecord(sequence, "transcript_item", sessionId, payload));
      sequence += 1;
    }
  }

  return records;
}

/**
 * Runtime convergence to `JsonObject`, never a cast.
 *
 * A window or a transcript item whose shape drifts — a nested object where the
 * model expects a scalar — must be dropped from the view rather than carried
 * into a journal record under an assertion that says it is JSON. The round trip
 * is what proves it: a value that survives `JSON.stringify`/`parse` and is a
 * non-null, non-array object is one, and anything else is not.
 */
function asJsonObject(value: unknown): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  try {
    const roundTripped: unknown = JSON.parse(JSON.stringify(value));
    if (typeof roundTripped !== "object" || roundTripped === null || Array.isArray(roundTripped)) {
      return undefined;
    }
    return roundTripped as JsonObject;
  } catch {
    return undefined;
  }
}

function viewRecord(
  sequence: number,
  type: SessionRecordType,
  sessionId: string,
  payload: JsonObject,
): SessionRecord {
  return {
    formatVersion: SESSION_FORMAT_VERSION,
    sequence,
    type,
    sessionId,
    at: VIEW_TIMESTAMP,
    payload,
  };
}

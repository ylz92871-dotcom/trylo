import type { JsonObject } from "../../protocol/envelope.js";
import {
  SESSION_FORMAT_VERSION,
  type RecoveryOutcome,
  type SessionPort,
  type SessionRecord,
  type SessionRecordView,
  type SessionRecordViewOutcome,
  type SessionStartInput,
} from "../../ports/session.js";
import { decodeJournal, encodeLine, splitLines } from "./codec.js";
import {
  acquireLock,
  appendJournalLine,
  createJournalIo,
  ensureJournalDirectory,
  journalExists,
  journalPosition,
  readJournalRaw,
  releaseLock,
  rewriteJournal,
  stillHoldingLock,
  type JournalIo,
  type NdjsonStoreConfig,
} from "./journal-io.js";
import { recover } from "./recovery.js";
import { purgeUnsettledToolCalls } from "./transcript-purge.js";

/**
 * Append-only, checksummed NDJSON session store.
 *
 * Recovery rules, in order of strictness:
 *  - a torn *tail* (a final line without its newline) is repairable, because the
 *    writer was interrupted mid-append and the fact was never acknowledged. The
 *    repair is explicit and removes bytes, it never rewrites earlier records;
 *  - anything else — bad checksum, sequence gap, unknown format version,
 *    corruption anywhere but the tail — fails closed. A session that cannot be
 *    proven intact is never partially replayed.
 *
 * Decoding lives in `codec.ts` and is shared by both read paths, so the
 * recovered projection and the raw record view can never disagree about what
 * the journal contains. The projection itself is `recovery.ts`, and the
 * filesystem mechanics (writer lock, fsynced append, truncating repair) are
 * `journal-io.ts`. What is left here is the port's own behaviour: which
 * precondition each method checks, in which order, and what it refuses.
 */

export type { StoredLine } from "./codec.js";
export { checksumFor, encodeLine, splitLines, decodeJournal } from "./codec.js";
export type { NdjsonStoreConfig };

type OkOrCode = { readonly ok: true } | { readonly ok: false; readonly code: string };

type AppendOutcome = { readonly ok: true; readonly sequence: number } | { readonly ok: false; readonly code: string };

type RepairOutcome =
  | { readonly ok: true; readonly removedBytes: number }
  | { readonly ok: false; readonly code: string };

export function createNdjsonSessionStore(config: NdjsonStoreConfig): SessionPort {
  const io = createJournalIo(config);
  return {
    start: (input) => startSession(io, input),
    attach: () => attachSession(io),
    append: (record) => appendRecord(io, record),
    repairTornTail: () => repairTornTail(io),
    read: () => readSession(io),
    readRecords: () => readSessionRecords(io),
    release: async () => releaseLock(io),
  };
}

async function startSession(io: JournalIo, input: SessionStartInput): Promise<OkOrCode> {
  if (journalExists(io)) {
    return { ok: false, code: "session_exists" };
  }

  if (!ensureJournalDirectory(io)) {
    return { ok: false, code: "directory_unavailable" };
  }

  const lock = acquireLock(io);
  if (!lock.ok) {
    return lock;
  }

  const record: SessionRecord = {
    formatVersion: SESSION_FORMAT_VERSION,
    sequence: 0,
    type: "session_start",
    sessionId: input.sessionId,
    at: input.createdAt,
    payload: { fingerprint: input.fingerprint as unknown as JsonObject },
  };
  if (!appendJournalLine(io, encodeLine(0, record))) {
    return { ok: false, code: "append_failed" };
  }

  return { ok: true };
}

async function attachSession(io: JournalIo): Promise<OkOrCode> {
  if (!journalExists(io)) {
    return { ok: false, code: "missing_session" };
  }
  return acquireLock(io);
}

async function appendRecord(
  io: JournalIo,
  record: Omit<SessionRecord, "formatVersion" | "sequence">,
): Promise<AppendOutcome> {
  if (!stillHoldingLock(io)) {
    return { ok: false, code: "lock_conflict" };
  }

  const { sequence, tornTail } = journalPosition(io);

  if (tornTail) {
    // Appending onto a partial line would bury it mid-file, where it can no
    // longer be told apart from real corruption. Repair first, explicitly.
    return { ok: false, code: "torn_tail_unrepaired" };
  }

  const full: SessionRecord = { ...record, formatVersion: SESSION_FORMAT_VERSION, sequence };
  if (!appendJournalLine(io, encodeLine(sequence, full))) {
    return { ok: false, code: "append_failed" };
  }

  return { ok: true, sequence };
}

async function repairTornTail(io: JournalIo): Promise<RepairOutcome> {
  if (!journalExists(io)) {
    return { ok: false, code: "missing_session" };
  }

  if (!stillHoldingLock(io)) {
    return { ok: false, code: "lock_conflict" };
  }

  const raw = readJournalRaw(io);
  const { tornTail } = splitLines(raw);

  if (!tornTail) {
    return { ok: true, removedBytes: 0 };
  }

  const lastNewline = raw.lastIndexOf("\n");
  const kept = raw.slice(0, lastNewline + 1);
  if (!rewriteJournal(io, kept)) {
    return { ok: false, code: "repair_failed" };
  }

  return { ok: true, removedBytes: raw.length - kept.length };
}

async function readSession(io: JournalIo): Promise<RecoveryOutcome> {
  const journal = await readSessionRecords(io);
  return journal.ok ? recoverSessionRecordView(journal.view) : journal;
}

/** Recover one already-decoded journal snapshot with the canonical read cleanup. */
export function recoverSessionRecordView(view: SessionRecordView): RecoveryOutcome {
  const outcome = recover(view.records, view.tornTail);
  if (!outcome.ok) {
    return outcome;
  }

  // Read-time cleanup of a crash between a tool call and its result: the
  // request is dropped from the projection, the journal itself is untouched.
  return {
    ok: true,
    session: { ...outcome.session, transcript: purgeUnsettledToolCalls(outcome.session.transcript) },
  };
}

async function readSessionRecords(io: JournalIo): Promise<SessionRecordViewOutcome> {
  if (!journalExists(io)) {
    return { ok: false, code: "missing_session", detail: io.file };
  }

  const decoded = decodeJournal(readJournalRaw(io));
  if (!decoded.ok) {
    return decoded;
  }

  return { ok: true, view: { records: decoded.records, tornTail: decoded.tornTail } };
}

import { createHash } from "node:crypto";
import type { RecoveryFailureCode, SessionRecord } from "../../ports/session.js";
import { SESSION_FORMAT_VERSION } from "../../ports/session.js";

/**
 * Line encoding and journal decoding for the append-only NDJSON session file.
 *
 * Split out from the store so that decoding stays a single source of truth:
 * the recover path and the raw record view must agree on every byte they read,
 * and two copies of this loop would be two opinions about what corruption is.
 */

export type StoredLine = {
  readonly sequence: number;
  readonly sum: string;
  readonly record: SessionRecord;
};

export function checksumFor(sequence: number, record: SessionRecord): string {
  return createHash("sha256").update(`${sequence}\u0000${JSON.stringify(record)}`).digest("hex");
}

export function encodeLine(sequence: number, record: SessionRecord): string {
  return `${JSON.stringify({ sequence, sum: checksumFor(sequence, record), record })}\n`;
}

/** Splits into complete lines and reports whether the tail was unterminated. */
export function splitLines(raw: string): { lines: readonly string[]; tornTail: boolean } {
  if (raw.length === 0) {
    return { lines: [], tornTail: false };
  }

  const parts = raw.split("\n");
  const last = parts[parts.length - 1] ?? "";
  // A file ending in "\n" yields a trailing "" that is not a record; a file
  // ending in anything else yields a partial record that must not be parsed.
  const tornTail = last !== "";

  return { lines: parts.slice(0, -1).filter((line) => line.trim().length > 0), tornTail };
}

export type JournalDecodeOutcome =
  | { readonly ok: true; readonly records: readonly SessionRecord[]; readonly tornTail: boolean }
  | { readonly ok: false; readonly code: RecoveryFailureCode; readonly detail: string };

/**
 * Validates every line in order and returns all records, or nothing.
 *
 * The order of checks is the order of how much they prove: a line that cannot
 * be parsed is reported before anything downstream can mistake it for history.
 * Every defect except a torn final line fails closed — including ones a lenient
 * reader could skip, because a skipped record is an invented past.
 */
export function decodeJournal(raw: string): JournalDecodeOutcome {
  const { lines, tornTail } = splitLines(raw);
  const records: SessionRecord[] = [];
  let expectedSequence = 0;

  for (const [index, line] of lines.entries()) {
    let parsed: StoredLine;

    try {
      parsed = JSON.parse(line) as StoredLine;
    } catch {
      return { ok: false, code: "mid_file_corruption", detail: `unparseable line ${index}` };
    }

    const record = parsed.record;
    if (record === undefined) {
      return { ok: false, code: "mid_file_corruption", detail: `no record at ${index}` };
    }

    if (record.formatVersion !== SESSION_FORMAT_VERSION) {
      return { ok: false, code: "unknown_format_version", detail: record.formatVersion };
    }

    if (record.sequence !== expectedSequence) {
      return { ok: false, code: "sequence_gap", detail: `${record.sequence} != ${expectedSequence}` };
    }

    if (parsed.sum !== checksumFor(record.sequence, record)) {
      return { ok: false, code: "checksum_mismatch", detail: `line ${index}` };
    }

    expectedSequence += 1;
    records.push(record);
  }

  return { ok: true, records, tornTail };
}

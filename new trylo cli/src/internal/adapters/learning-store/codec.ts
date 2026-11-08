import type { BoardCommand } from "../../learning/control/commands.js";
import type { BoardEvent } from "../../learning/control/events.js";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import type { ReasonCode } from "../../learning/control/reasons.js";

export type LogRecord = {
  readonly sequence: number;
  readonly commandId: string;
  readonly command: BoardCommand;
  readonly events: ReadonlyArray<BoardEvent>;
};

export type CodecErr = {
  readonly ok: false;
  readonly reason: Extract<
    ReasonCode,
    "checksum_mismatch" | "torn_write" | "sequence_gap" | "snapshot_corrupt"
  >;
  readonly detail: string;
};

export type ParsedLog = {
  readonly ok: true;
  readonly records: ReadonlyArray<LogRecord>;
  readonly discardedTornTail: boolean;
};

export function encodeRecord(record: LogRecord): string {
  const payload = canonicalJson(record);
  return `${sha256Hex(payload)} ${payload}\n`;
}

export function decodeLog(raw: string): ParsedLog | CodecErr {
  return decodeLogSuffix(raw, 1);
}

/** An already verified complete prefix supplies the next physical record sequence. */
export function decodeLogSuffix(raw: string, nextSequence: number): ParsedLog | CodecErr {
  if (raw.length === 0) {
    return { ok: true, records: [], discardedTornTail: false };
  }

  const torn = !raw.endsWith("\n");
  const text = torn ? raw.slice(0, raw.lastIndexOf("\n") + 1) : raw;
  if (torn && text.length === 0) {
    return { ok: true, records: [], discardedTornTail: true };
  }

  const lines = text.split("\n").filter((line) => line.length > 0);
  const records: LogRecord[] = [];
  let expected = nextSequence;

  for (const line of lines) {
    const parsed = decodeLine(line, expected);
    if (!parsed.ok) {
      return parsed;
    }
    records.push(parsed.record);
    expected = parsed.record.sequence + 1;
  }

  return { ok: true, records, discardedTornTail: torn };
}

function decodeLine(
  line: string,
  expectedSequence: number,
): { ok: true; record: LogRecord } | CodecErr {
  const space = line.indexOf(" ");
  if (space <= 0) {
    return { ok: false, reason: "checksum_mismatch", detail: "missing checksum" };
  }

  const checksum = line.slice(0, space);
  const payload = line.slice(space + 1);
  if (sha256Hex(payload) !== checksum) {
    return { ok: false, reason: "checksum_mismatch", detail: `seq~${expectedSequence}` };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch {
    return {
      ok: false,
      reason: "snapshot_corrupt",
      detail: `unparseable record at seq~${expectedSequence}`,
    };
  }

  // The checksum proves the bytes; it cannot prove the payload still matches
  // its type. The store's own compaction reads `events[i].sequence` and its
  // reload feeds `command` to the board reducer — so the boundary guards the
  // structure both depend on, and the reducer keeps the deeper command/event
  // authority (unknown commands are its `unknown_command`, not ours to guess).
  if (!isLogRecordShape(parsed)) {
    return {
      ok: false,
      reason: "snapshot_corrupt",
      detail: `record at seq~${expectedSequence} is not a log record`,
    };
  }

  const record = parsed;
  if (record.sequence !== expectedSequence) {
    return {
      ok: false,
      reason: "sequence_gap",
      detail: `expected ${expectedSequence} got ${String(record.sequence)}`,
    };
  }

  return { ok: true, record };
}

function isLogRecordShape(value: unknown): value is LogRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.sequence !== "number" || !Number.isInteger(record.sequence)) {
    return false;
  }

  if (typeof record.commandId !== "string" || record.commandId.length === 0) {
    return false;
  }

  if (typeof record.command !== "object" || record.command === null || Array.isArray(record.command)) {
    return false;
  }

  if (!Array.isArray(record.events)) {
    return false;
  }

  return record.events.every((event) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      return false;
    }
    const sequence = (event as Record<string, unknown>).sequence;
    return typeof sequence === "number" && Number.isInteger(sequence);
  });
}

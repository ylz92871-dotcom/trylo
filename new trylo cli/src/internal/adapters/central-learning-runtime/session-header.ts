import { open, type FileHandle } from "node:fs/promises";
import { isRuntimeFingerprint } from "../../ports/session.js";
import { decodeJournal } from "../session-store/codec.js";
import { isLockIoCode } from "../learning-store/lock-files.js";

export type RuntimeSessionHeaderFailure = "session_header_missing" | "session_header_cancelled" | "session_header_invalid"
  | "session_header_capacity" | "session_header_io";

export type RuntimeSessionHeaderRead = {
  readonly ok: true; readonly value: { readonly sessionId: string; readonly workspaceId: string; readonly workspaceRoot?: string };
} | { readonly ok: false; readonly reason: RuntimeSessionHeaderFailure };

const MAXIMUM_HEADER_BYTES = 65536;
const READ_CHUNK_BYTES = 4096;
const failed = (reason: RuntimeSessionHeaderFailure): RuntimeSessionHeaderRead => ({ ok: false, reason });

/** Bounded registry identity probe. Only the complete first line reaches the original codec; later bytes prove nothing here. */
export async function readRuntimeSessionHeader(file: string, expectedSessionId: string, signal: AbortSignal): Promise<RuntimeSessionHeaderRead> {
  if (signal.aborted) return failed("session_header_cancelled");

  let handle: FileHandle | undefined;
  let outcome: RuntimeSessionHeaderRead = failed("session_header_io");

  try {
    handle = await open(file, "r");
    outcome = await readFirstLine(handle, expectedSessionId, signal);
  } catch (error) {
    outcome = signal.aborted ? failed("session_header_cancelled")
      : failed(isLockIoCode(error, "ENOENT") ? "session_header_missing" : "session_header_io");
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); }
      catch { outcome = failed("session_header_io"); } // A failed close is observable, never a successful identity probe.
    }
  }

  return signal.aborted ? failed("session_header_cancelled") : outcome;
}

async function readFirstLine(handle: FileHandle, expectedSessionId: string, signal: AbortSignal): Promise<RuntimeSessionHeaderRead> {
  const buffer = Buffer.alloc(MAXIMUM_HEADER_BYTES);
  let used = 0;

  while (used < buffer.length) {
    if (signal.aborted) return failed("session_header_cancelled");

    const read = await handle.read(buffer, used, Math.min(READ_CHUNK_BYTES, buffer.length - used), used);

    if (signal.aborted) return failed("session_header_cancelled");

    if (read.bytesRead === 0) return failed("session_header_invalid");

    used += read.bytesRead;
    const end = buffer.subarray(0, used).indexOf(0x0a);
    if (end >= 0) return decodeHeader(buffer.toString("utf8", 0, end + 1), expectedSessionId);
  }

  return failed("session_header_capacity");
}

function decodeHeader(firstLine: string, expectedSessionId: string): RuntimeSessionHeaderRead {
  try {
    const decoded = decodeJournal(firstLine);
    if (!decoded.ok || decoded.tornTail || decoded.records.length !== 1) return failed("session_header_invalid");

    const record = decoded.records[0];
    if (record === undefined || record.type !== "session_start" || record.sessionId !== expectedSessionId || !expectedSessionId
      || typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)
      || !isRuntimeFingerprint(record.payload.fingerprint) || !record.payload.fingerprint.workspaceId) return failed("session_header_invalid");

    const fingerprint = record.payload.fingerprint;

    return { ok: true, value: { sessionId: record.sessionId, workspaceId: fingerprint.workspaceId,
      ...(fingerprint.workspaceRoot === undefined ? {} : { workspaceRoot: fingerprint.workspaceRoot }) } };
  } catch {
    // The original codec can reject malformed JSON shapes by throwing; none establishes a registry identity.
    return failed("session_header_invalid");
  }
}

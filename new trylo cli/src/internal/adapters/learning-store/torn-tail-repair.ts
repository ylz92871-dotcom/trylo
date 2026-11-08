import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StoreLoadErr } from "../../learning/control/store-port.js";
import { decodeLog } from "./codec.js";
import { createBoardReader } from "./file-event-store.js";
import { ownsLock, releaseLock, tryAcquireLock, type BoardLockOptions, type LockHandle } from "./lock.js";

export type TornTailRepairOptions = {
  readonly lockOptions?: BoardLockOptions;
  readonly createToken?: () => string;
  readonly onStage?: (stage: "evidence_saved" | "before_truncate" | "after_truncate") => void;
};

export type TornTailRepairResult = StoreLoadErr | {
  readonly ok: true;
  readonly status: "not_needed" | "repaired";
  readonly evidenceDirectory?: string;
  readonly originalSha256?: string;
  readonly retainedBytes?: number;
};

/** Explicit, local-only repair: quarantine all original bytes before removing an invalid tail. */
export async function repairBoardTornTail(root: string, options: TornTailRepairOptions = {}): Promise<TornTailRepairResult> {
  try {
    if (!existsSync(root)) return { ok: true, status: "not_needed" };

    const acquired = tryAcquireLock(path.join(root, "board-writer.lock"), options.lockOptions);
    if ("ok" in acquired) return acquired;

    let result: TornTailRepairResult;

    try {
      result = await repairUnderLock(root, acquired, options);
    } catch (error) {
      result = unavailable(error);
    }

    try {
      releaseLock(acquired);
    } catch (error) {
      // Evidence and any completed truncation remain; cleanup failure is not reported as success.
      return unavailable(error);
    }

    return result;
  } catch (error) {
    return unavailable(error);
  }
}

async function repairUnderLock(root: string, lock: LockHandle, options: TornTailRepairOptions): Promise<TornTailRepairResult> {
  const log = path.join(root, "board-events.ndjson");
  if (!existsSync(log)) return { ok: true, status: "not_needed" };

  const original = readFileSync(log);
  const text = original.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(original)) return unavailable("Board log is not canonical UTF-8; manual recovery required");

  const decoded = decodeLog(text);
  if (!decoded.ok) return decoded;

  if (!decoded.discardedTornTail) return { ok: true, status: "not_needed" };

  // Codec validity alone cannot prove the existing Board commands can still replay.
  const before = await createBoardReader(root).load();
  if (!before.ok) return before;

  const offset = original.lastIndexOf(0x0a) + 1;
  const prefix = original.subarray(0, offset);
  const tail = original.subarray(offset);
  const validPrefix = decodeLog(prefix.toString("utf8"));
  if (!validPrefix.ok || validPrefix.discardedTornTail || validPrefix.records.length !== decoded.records.length) {
    return unavailable("Board valid-prefix verification failed; no bytes changed");
  }

  if (!ownsLock(lock)) return lostLock();

  const evidence = preserveEvidence(root, original, prefix, tail, options.createToken ?? randomUUID);

  options.onStage?.("evidence_saved");
  const fd = openSync(log, "r+");

  try {
    options.onStage?.("before_truncate");

    if (!readFileSync(fd).equals(original)) return unavailable("Board log changed after quarantine; no bytes truncated");

    if (!readFileSync(path.join(evidence.directory, "original.ndjson")).equals(original) ||
      !readFileSync(path.join(evidence.directory, "tail.bin")).equals(tail) ||
      !readFileSync(path.join(evidence.directory, "evidence.json")).equals(evidence.metadata)) {
      return unavailable("Board quarantine changed before truncation; no bytes changed");
    }

    if (!ownsLock(lock)) return lostLock();

    // No await between fence, truncation and fsync. Never append or synthesize an event.
    ftruncateSync(fd, offset);
    fsyncSync(fd);
    options.onStage?.("after_truncate");
  } finally {
    closeSync(fd);
  }

  if (!readFileSync(log).equals(prefix)) return unavailable("Board repaired prefix differs from saved evidence");

  const after = await createBoardReader(root).load();
  if (!after.ok) return after;

  return { ok: true, status: "repaired", evidenceDirectory: evidence.directory, originalSha256: digest(original), retainedBytes: offset };
}

function preserveEvidence(root: string, original: Buffer, prefix: Buffer, tail: Buffer, token: () => string): { readonly directory: string; readonly metadata: Buffer } {
  const nonce = token();
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(nonce)) throw new Error("invalid Board quarantine nonce");

  const quarantine = path.join(root, "quarantine");

  mkdirSync(quarantine, { recursive: true });
  const directory = path.join(quarantine, `torn-${digest(original)}-${nonce}`);

  mkdirSync(directory);
  durableEvidence(path.join(directory, "original.ndjson"), original);
  durableEvidence(path.join(directory, "tail.bin"), tail);
  const metadata = {
    formatVersion: 1, kind: "board_torn_tail", originalBytes: original.length,
    originalSha256: digest(original), retainedBytes: prefix.length, retainedSha256: digest(prefix),
    tailBytes: tail.length, tailSha256: digest(tail),
  };
  // Metadata is the final completeness marker; a partial bundle never authorizes truncation.
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");

  durableEvidence(path.join(directory, "evidence.json"), metadataBytes);

  if (!readFileSync(path.join(directory, "original.ndjson")).equals(original) || !readFileSync(path.join(directory, "tail.bin")).equals(tail)) {
    throw new Error("Board quarantine readback mismatch");
  }

  return { directory, metadata: metadataBytes };
}

function durableEvidence(file: string, bytes: Buffer): void {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unavailable(error: unknown): StoreLoadErr {
  return { ok: false, reason: "board_unavailable", detail: `board_torn_tail_repair: ${error instanceof Error ? error.message : String(error)}` };
}

function lostLock(): StoreLoadErr {
  return { ok: false, reason: "multi_writer", detail: "Board ownership changed before torn-tail repair" };
}

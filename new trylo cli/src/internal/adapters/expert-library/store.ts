import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ExpertLibraryError, type ExpertLibrarySnapshot, type ExpertStorePort } from "../../subagent/experts/contracts.js";
import { validateSnapshot } from "../../subagent/experts/validation.js";
import { ownsLock, releaseLock, tryAcquireLock, type BoardLockOptions } from "../learning-store/lock.js";

const FILE_NAME = "expert-library.v1.json";
const LOCK_NAME = "expert-library.lock";
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export type ExpertStoreStage = "prepared" | "before_publish";

export type FileExpertStoreOptions = {
  readonly lockOptions?: BoardLockOptions;
  readonly createToken?: () => string;
  /** Synchronous fault seam; production uses actual fsync and atomic rename. */
  readonly onStage?: (stage: ExpertStoreStage) => void;
};

/** One schema file, one CAS writer. Reads never fabricate an empty store on corruption. */
export function createFileExpertStore(rootDir: string, options: FileExpertStoreOptions = {}): ExpertStorePort {
  const file = path.join(rootDir, FILE_NAME);
  const lockFile = path.join(rootDir, LOCK_NAME);
  const createToken = options.createToken ?? randomUUID;

  return {
    read: () => readSnapshot(file),
    update(expectedSequence, next) {
      if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0 || next.sequence !== expectedSequence + 1) {
        throw new ExpertLibraryError("conflict", "Expert store sequence must advance exactly once");
      }

      const validated = validateSnapshot(next);
      const body = `${JSON.stringify(validated)}\n`;
      if (Buffer.byteLength(body, "utf8") > MAX_FILE_BYTES) throw new ExpertLibraryError("invalid_input", "Expert library exceeds its storage limit");

      try {
        mkdirSync(rootDir, { recursive: true });
        const lock = tryAcquireLock(lockFile, options.lockOptions);
        if (!("fd" in lock)) {
          throw new ExpertLibraryError(lock.reason === "multi_writer" ? "conflict" : "store_unavailable", "Expert library writer is unavailable");
        }

        try {
          const current = readSnapshot(file);
          if (current.sequence !== expectedSequence) throw new ExpertLibraryError("conflict", "Expert library changed; read it again before writing");
          preserveVersionHistory(current, validated);
          publishSnapshot(file, body, createToken(), () => ownsLock(lock), options.onStage);
        } finally {
          releaseLock(lock);
        }
      } catch (error) {
        if (error instanceof ExpertLibraryError) throw error;
        throw new ExpertLibraryError("store_unavailable", "Expert library write could not be committed; read the current sequence before retrying");
      }
    },
  };
}

function readSnapshot(file: string): ExpertLibrarySnapshot {
  let fd: number | undefined;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("invalid expert snapshot file");

    fd = openSync(file, "r");
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_FILE_BYTES) throw new Error("invalid expert snapshot file");

    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));

    return validateSnapshot(value);
  } catch (error) {
    if (isIoCode(error, "ENOENT")) return { schemaVersion: 1, sequence: 0, experts: [], requests: [] };
    throw new ExpertLibraryError("store_unavailable", "Expert library is unreadable or has an unsupported schema; existing data was preserved");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function preserveVersionHistory(current: ExpertLibrarySnapshot, next: ExpertLibrarySnapshot): void {
  for (const previous of current.experts) {
    const candidate = next.experts.find(expert => expert.expertId === previous.expertId);
    if (candidate === undefined || candidate.experienceKey !== previous.experienceKey || candidate.versions.length < previous.versions.length
      || previous.versions.some((version, index) => !isDeepStrictEqual(version, candidate.versions[index]))) {
      throw new ExpertLibraryError("conflict", "Saved expert identity and version history are immutable; append a version or archive the expert");
    }
  }
}

function publishSnapshot(file: string, body: string, token: string, ownsWriter: () => boolean, onStage: FileExpertStoreOptions["onStage"]): void {
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(token)) throw new ExpertLibraryError("invalid_input", "Invalid expert store publication token");

  const prepared = `${file}.prepared-${token}`;
  const fd = openSync(prepared, "wx", 0o600);
  let closed = false;

  try {
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    onStage?.("prepared");
    closeSync(fd);
    closed = true;
    onStage?.("before_publish");

    // No asynchronous work between fencing and publication. A crash leaves either
    // the old snapshot or the entire new snapshot, never a half-written JSON file.
    if (!ownsWriter()) throw new ExpertLibraryError("conflict", "Expert library writer lost ownership before publication");

    renameSync(prepared, file);
  } finally {
    if (!closed) closeSync(fd);
    try { unlinkSync(prepared); }
    catch (error) {
      // After rename the preparation path is absent; every other cleanup fault
      // is surfaced so callers re-read rather than assume that no write occurred.
      if (!isIoCode(error, "ENOENT")) throw error;
    }
  }
}

function isIoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

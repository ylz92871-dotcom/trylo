import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Whole-file replace, never in-place edit.
 *
 * The file appearing at its destination is a rename, which is atomic on every
 * platform this package targets: a reader either sees the old bytes or the new
 * ones, and a crash leaves at most an abandoned temporary file. Nothing here
 * can produce a half-written file, which is the failure mode that makes "the
 * tool reported success" untrustworthy.
 */

export type WriteOutcome = {
  readonly absolutePath: string;
  readonly bytes: number;
  readonly mode: "created" | "overwritten";
};

export type WriteQueue = {
  /** Runs `job` after every job already queued for this path. */
  exclusive<T>(absolutePath: string, job: () => Promise<T>): Promise<T>;
};

/**
 * Same-path serialisation. Renames are atomic, but a read-modify-write is not:
 * two concurrent edits would otherwise both read the same bytes and the second
 * would silently lose the first.
 */
export function createWriteQueue(): WriteQueue {
  const chains = new Map<string, Promise<unknown>>();
  return {
    exclusive(absolutePath, job) {
      const previous = chains.get(absolutePath) ?? Promise.resolve();
      const run = () => job();
      const next = previous.then(run, run);

      chains.set(
        absolutePath,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );

      return next;
    },
  };
}

function discard(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Nothing can be salvaged here and nothing should replace the failure that
    // is already being reported, so the only honest action is to move on.
  }
}

export function writeFileAtomically(
  absolutePath: string,
  content: string,
  queue: WriteQueue,
): Promise<WriteOutcome> {
  return queue.exclusive(absolutePath, async () => writeFileAtomicallySync(absolutePath, content));
}

/**
 * The queue-free core: temp file plus rename, so a crash leaves at most an
 * abandoned temporary. Callers that already hold queue exclusivity (a
 * read-compare-write spanning one file) use this directly instead of nesting
 * a second exclusive section, which would deadlock against itself.
 */
export function writeFileAtomicallySync(absolutePath: string, content: string): WriteOutcome {
  const bytes = Buffer.byteLength(content, "utf8");
  const mode = existsSync(absolutePath) ? "overwritten" : "created";
  const temporary = path.join(path.dirname(absolutePath), `.trylo-write-${randomUUID()}.tmp`);

  try {
    // `wx` rather than `w`: the temporary name is random, so an existing file
    // means something is wrong, and truncating someone else's file would be
    // the wrong way to find out.
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, absolutePath);
  } catch (err) {
    discard(temporary);
    throw err;
  }

  return { absolutePath, bytes, mode };
}

export function readFileUtf8(absolutePath: string): string {
  return readFileSync(absolutePath, "utf8");
}

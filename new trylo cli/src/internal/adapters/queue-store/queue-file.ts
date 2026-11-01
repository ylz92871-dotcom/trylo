import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { rename } from "node:fs/promises";
import { isFilesystemBusy } from "../filesystem/busy-error.js";

/**
 * The bytes of a queue file: read it whole, append one line, rewrite it whole.
 *
 * Deliberately the smallest thing that can do those three jobs, because every
 * one of them has a failure mode that must be reported rather than guessed at.
 * `readAll` distinguishes "no file" (an empty queue, which is a real state) from
 * "a file I could not read" (which is not the same claim, and must never be
 * reported as an empty queue — see the port's `queue_unreadable`).
 *
 * Durability rules, both of them load-bearing:
 *
 *  - **An append is fsynced before it is acknowledged.** A process that dies
 *    after being told "queued" must find the message still there.
 *  - **A rewrite goes through a temporary file and a rename.** Rename within
 *    one filesystem is the one operation both POSIX and Windows promise to be
 *    atomic, so a reader sees either the whole old queue or the whole new one —
 *    never a prefix that decodes as corruption. The previous queue is not
 *    modified in place at any point.
 */

export type ReadOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: "queue_unreadable" };

/** Absent is an empty queue; unreadable is not, and says so. */
export function readAll(file: string): ReadOutcome {
  try {
    if (!existsSync(file)) {
      return { ok: true, text: "" };
    }
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch {
    return { ok: false, code: "queue_unreadable" };
  }
}

/** One line, fsynced, or nothing at all — a partial line is never left behind. */
export function appendLine(file: string, line: string): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const handle = openSync(file, "a");
    try {
      writeSync(handle, line);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    return true;
  } catch {
    return false;
  }
}

/** Replace the file with `contents` atomically, or leave it exactly as it was. */
export function rewriteAll(file: string, contents: string): boolean {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeReplacement(temporary, contents);
    renameSync(temporary, file);
    return true;
  } catch {
    return false;
  } finally {
    cleanReplacement(temporary);
  }
}

function writeReplacement(temporary: string, contents: string): void {
  mkdirSync(path.dirname(temporary), { recursive: true });
  const handle = openSync(temporary, "w");
  try {
    writeSync(handle, contents);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function cleanReplacement(temporary: string): void {
  try {
    if (existsSync(temporary)) unlinkSync(temporary);
  } catch {
    // A locked pid-stamped temporary is not the acknowledged queue. The old
    // destination stays intact and the caller still receives a failed write.
  }
}

export type QueueReplaceIo = {
  readonly replace: (from: string, to: string) => Promise<void>;
  readonly wait: (milliseconds: number) => Promise<void>;
};

/**
 * Windows may momentarily deny an atomic rename while a scanner holds the file.
 * The queue's writer lock remains held for these four bounded attempts. Never
 * unlink the destination or acknowledge a replacement that did not happen.
 */
export async function rewriteQueuedFile(file: string, contents: string, io: QueueReplaceIo = {
  replace: rename,
  wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}): Promise<boolean> {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeReplacement(temporary, contents);
    const delays = [0, 10, 25, 75];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      await io.wait(delays[attempt] ?? 0);
      try {
        await io.replace(temporary, file);
        return true;
      } catch (error) {
        if (!isFilesystemBusy(error) || attempt === delays.length - 1) throw error;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    cleanReplacement(temporary);
  }
}

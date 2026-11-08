/**
 * The durable side of one session's background queue.
 *
 * The file is NDJSON, one queued message per line, oldest first — the order is
 * the file order, so there is no separate index to fall out of step with the
 * contents. Updating and reordering therefore rewrite the file, while enqueue
 * appends; the choice is per-verb rather than per-file because appending is the
 * only verb two processes are likely to attempt at the same moment, and it is
 * the only one that can be made atomic by appending alone.
 *
 * **One writer, proven.** Codex's queue service takes a per-thread mutex around
 * every mutation and calls the storage layer "durable"; the mutex is what makes
 * two in-process callers safe. It is not enough across processes, and the
 * single-writer rule has to reach the file itself — see `writer.ts`.
 *
 * Every read re-reads the file rather than trusting a cached copy: another
 * process may have appended since the last call, and a queue that reported its
 * own stale length would admit the hundred-and-first message.
 */

import {
  MAX_QUEUED_MESSAGES,
  type BackgroundQueue,
  type QueueClock,
  type QueuePage,
  type QueueResult,
} from "../../ports/background-queue.js";
import { enqueueVerdict, isPermutation } from "../../domain/background-queue.js";
import { appendLine, readAll, rewriteQueuedFile } from "./queue-file.js";
import { writerLock, type QueueLock } from "./queue-writer.js";

export type FileQueueConfig = {
  /** Absolute path of this session's queue file. */
  readonly path: string;
  readonly clock: QueueClock;
};

type StoredLine = {
  readonly id: string;
  readonly text: string;
  readonly enqueuedAtMs: number;
};

/**
 * Decoding is where corruption is refused.
 *
 * A line that does not parse, or that parses to the wrong shape, fails the
 * whole read with `queue_unreadable` — never silently skipped. Skipping would
 * let a torn write look like a shorter queue, and the next `enqueue` would then
 * append after a gap nobody can see; the person who queued the missing message
 * would be told nothing is wrong.
 */
function decode(raw: string): QueueResult<ReadonlyArray<StoredLine>> {
  if (raw.trim().length === 0) {
    return { ok: true, value: [] };
  }

  const items: StoredLine[] = [];
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  for (const line of lines) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, code: "queue_unreadable" };
    }

    if (!isStoredLine(parsed)) {
      return { ok: false, code: "queue_unreadable" };
    }

    items.push(parsed);
  }

  return { ok: true, value: items };
}

function isStoredLine(value: unknown): value is StoredLine {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record["id"] === "string" &&
    typeof record["text"] === "string" &&
    typeof record["enqueuedAtMs"] === "number" &&
    Number.isFinite(record["enqueuedAtMs"])
  );
}

/** Re-encodes one item. Written in one place so the file shape has one owner. */
function encode(item: StoredLine): string {
  return `${JSON.stringify({ id: item.id, text: item.text, enqueuedAtMs: item.enqueuedAtMs })}\n`;
}

export function createFileBackgroundQueue(config: FileQueueConfig): BackgroundQueue {
  const lock = writerLock(config.path);
  return {
    list: (offset, limit) => locked(lock, async () => {
      if (limit <= 0) {
        return { ok: false, code: "queue_unreadable" } as const;
      }

      const raw = readAll(config.path);
      if (!raw.ok) {
        return raw;
      }

      const decoded = decode(raw.text);
      if (!decoded.ok) {
        return decoded;
      }

      const page: QueuePage = {
        items: decoded.value.slice(offset, offset + limit),
        total: decoded.value.length,
      };

      return { ok: true, value: page };
    }),

    enqueue: (text) => locked(lock, async () => {
      const raw = readAll(config.path);
      if (!raw.ok) {
        return raw;
      }

      const decoded = decode(raw.text);
      if (!decoded.ok) {
        return decoded;
      }

      const verdict = enqueueVerdict(text, decoded.value.length);
      if (verdict.kind === "refused") {
        return { ok: false, code: verdict.code } as const;
      }

      const item: StoredLine = {
        id: config.clock.newId("q"),
        text: verdict.text,
        enqueuedAtMs: config.clock.now(),
      };
      if (!appendLine(config.path, encode(item))) {
        return { ok: false, code: "queue_unwritable" } as const;
      }

      return { ok: true, value: item } as const;
    }),

    /**
     * Put a message back with **its own id and arrival time** (worker restore).
     *
     * `enqueue` mints a fresh id, which is right for a person queueing new work and
     * wrong for putting a claimed message back: the durable handoff record is keyed
     * by the original message id, so a re-added copy with a new id is a message
     * that looks unrecorded — and the "never re-run a job whose outcome is unknown"
     * rule quietly stops holding. That is not hypothetical: it is what this verb
     * exists for.
     *
     * Re-presenting an id that is already queued is a no-op that returns the
     * existing entry (codex's `created: false`), because a duplicate would be the
     * same sentence asked twice.
     */
    requeue: (message) => locked(lock, async () => {
      const raw = readAll(config.path);
      if (!raw.ok) {
        return raw;
      }

      const decoded = decode(raw.text);
      if (!decoded.ok) {
        return decoded;
      }

      const already = decoded.value.find((item) => item.id === message.id);
      if (already !== undefined) {
        return { ok: true, value: already } as const;
      }

      const verdict = enqueueVerdict(message.text, decoded.value.length);
      if (verdict.kind === "refused") {
        return { ok: false, code: verdict.code } as const;
      }

      const item: StoredLine = {
        id: message.id,
        text: verdict.text,
        enqueuedAtMs: message.enqueuedAtMs,
      };
      if (!appendLine(config.path, encode(item))) {
        return { ok: false, code: "queue_unwritable" } as const;
      }

      return { ok: true, value: item } as const;
    }),

    update: (id, text) => locked(lock, async () => {
      const raw = readAll(config.path);
      if (!raw.ok) {
        return raw;
      }

      const decoded = decode(raw.text);
      if (!decoded.ok) {
        return decoded;
      }

      const verdict = enqueueVerdict(text, decoded.value.length);
      if (verdict.kind === "refused") {
        return { ok: false, code: verdict.code } as const;
      }

      const index = decoded.value.findIndex((item) => item.id === id);
      const found = decoded.value[index];
      if (index < 0 || found === undefined) {
        return { ok: false, code: "unknown_item" } as const;
      }

      const updated: StoredLine = { ...found, text: verdict.text };
      const next = [...decoded.value];

      next[index] = updated;

      if (!await rewriteQueuedFile(config.path, next.map(encode).join(""))) {
        return { ok: false, code: "queue_unwritable" } as const;
      }

      return { ok: true, value: updated } as const;
    }),

    delete: (id) => locked(lock, async () => {
      const raw = readAll(config.path);
      if (!raw.ok) {
        return raw;
      }

      const decoded = decode(raw.text);
      if (!decoded.ok) {
        return decoded;
      }

      const next = decoded.value.filter((item) => item.id !== id);
      if (next.length === decoded.value.length) {
        return { ok: false, code: "unknown_item" } as const;
      }

      if (!await rewriteQueuedFile(config.path, next.map(encode).join(""))) {
        return { ok: false, code: "queue_unwritable" } as const;
      }

      return { ok: true, value: true } as const;
    }),

    reorder: (orderedIds) => locked(lock, async () => {
      const raw = readAll(config.path);
      if (!raw.ok) {
        return raw;
      }

      const decoded = decode(raw.text);
      if (!decoded.ok) {
        return decoded;
      }

      const byId = new Map(decoded.value.map((item) => [item.id, item]));

      if (!isPermutation(decoded.value.map((item) => item.id), orderedIds)) {
        return { ok: false, code: "order_not_a_permutation" } as const;
      }

      // Every id was just proven to be present exactly once, so this lookup
      // cannot miss; `flatMap` keeps that guarantee visible instead of asserting.
      const next = orderedIds.flatMap((id) => {
        const item = byId.get(id);
        return item === undefined ? [] : [item];
      });
      if (next.length !== decoded.value.length) {
        return { ok: false, code: "order_not_a_permutation" } as const;
      }

      if (!await rewriteQueuedFile(config.path, next.map(encode).join(""))) {
        return { ok: false, code: "queue_unwritable" } as const;
      }

      return { ok: true, value: true } as const;
    }),

    release: () => lock.release(),
  };
}

/**
 * Runs `body` under the writer lock and always gives the lock back.
 *
 * The return type says what actually happens: either the body's own
 * `QueueResult`, or `queue_locked` when another writer holds the file. A
 * signature claiming the body's type alone would be a lie the caller could not
 * see — it would let every verb assume it can read `value`, and the one time
 * that assumption fails (a second `trylo queue` racing this one) it would fail
 * on a `undefined` instead of saying the queue was locked.
 *
 * A refusal inside the body is a *result*, not a reason to keep the lock: the
 * lock belongs to the operation, and an operation that has decided something
 * has ended. Holding it past that would turn one refused message into a queue
 * nobody can touch.
 */
function locked<T>(
  lock: QueueLock,
  body: () => Promise<QueueResult<T>>,
): Promise<QueueResult<T>> {
  return lock.run(body);
}

export { MAX_QUEUED_MESSAGES };

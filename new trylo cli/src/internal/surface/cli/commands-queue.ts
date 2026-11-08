import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { createFileBackgroundQueue } from "../../adapters/queue-store/file-queue.js";
import type {
  QueueAddOptions,
  QueueDropOptions,
  QueueListOptions,
} from "./args-queue.js";
import type { CliContext } from "./context.js";
import { relativeTime } from "./humanize.js";
import { reportFailure } from "./run-failure.js";
import { sessionQueuePath } from "./session-paths.js";
import type { QueueFailureCode, QueueResult } from "../../ports/background-queue.js";

/**
 * `trylo queue` handlers (WP08 / C41).
 *
 * The use this exists for is a person in a second terminal: the session is busy
 * or gone, and there is no prompt to type at, so a message is written where the
 * session will find it when it next goes idle. That is why this command never
 * starts a turn, never loads a session, and never touches a provider — it is a
 * write to a queue, and a command that did more would be a second way to run a
 * turn, with its own idea of which session is current.
 *
 * **Every refusal says which remedy applies.** `queue_locked` in particular is
 * not an error a person can act on by retrying immediately, so it names the
 * other writer instead of pretending to be transient: a lock file left by a
 * crashed process stays until somebody looks at it, and silently unlinking it
 * would be the one behaviour that could lose a message.
 *
 * A queue that could not be *read* never prints as an empty queue. `list` with
 * an unreadable queue is an exit code and a message, because "you have nothing
 * queued" and "I could not find out" lead to opposite conclusions and only one
 * of them is true.
 */

const TRANSIENT: ReadonlySet<QueueFailureCode> = new Set(["queue_locked", "queue_unwritable"]);

/** `queue_locked` is not retry-now advice, so it gets its own class. */
function exitCodeFor(code: QueueFailureCode): ExitCode {
  return TRANSIENT.has(code) ? EXIT_CODES.TEMPORARY : EXIT_CODES.USAGE;
}

function queueOf(ctx: CliContext, sessionId: string) {
  return createFileBackgroundQueue({
    path: sessionQueuePath(ctx.homeDir, ctx.env, sessionId),
    clock: { now: ctx.now, newId: ctx.newId },
  });
}

/** The value, or the refusal to render. Keeps each handler from re-testing `ok`. */
type Unwrapped<T> = { readonly value: T } | { readonly code: QueueFailureCode };

function unwrap<T>(outcome: QueueResult<T>): Unwrapped<T> {
  return outcome.ok ? { value: outcome.value } : { code: outcome.code };
}

function explain(code: QueueFailureCode): { readonly message: string; readonly hint: string } {
  switch (code) {
    case "blank":
      return {
        message: "there is no message in --message",
        hint: "type something after --message, or drop the command",
      };
    case "full":
      return {
        message: "this session's queue is full (100 messages)",
        hint: "run `trylo queue list --session <id>` to see what is waiting, and drop what you no longer want",
      };
    case "unknown_item":
      return {
        message: "no queued message has that id in this session",
        hint: "run `trylo queue list --session <id>` for the current ids",
      };
    case "order_not_a_permutation":
      return {
        message: "a reorder has to name every queued message exactly once",
        hint: "this is an internal rule, not something you typed; report it with the ids you used",
      };
    case "queue_locked":
      return {
        message: "another writer is holding this session's queue",
        hint: "wait for it to finish; if the lock is left by a process that died, remove the .lock file beside the queue once you are sure nothing is running",
      };
    case "queue_unwritable":
      return {
        message: "the queue could not be written",
        hint: "check that the trylo home directory is writable, then try again",
      };
    case "queue_unreadable":
      return {
        message: "the queue exists but could not be read",
        hint: "it is refused rather than reported as empty, because an unreadable queue is not an empty one",
      };
  }
}

function refuse(ctx: CliContext, code: QueueFailureCode): ExitCode {
  const { message, hint } = explain(code);
  return reportFailure(ctx, { exitCode: exitCodeFor(code), message, hint });
}

export async function handleQueueAdd(ctx: CliContext, options: QueueAddOptions): Promise<ExitCode> {
  const queue = queueOf(ctx, options.sessionId);
  try {
    const got = unwrap(await queue.enqueue(options.text));
    if ("code" in got) {
      return refuse(ctx, got.code);
    }

    const queued = got.value;

    if (options.json) {
      ctx.stdout(`${JSON.stringify({ ok: true, id: queued.id, sessionId: options.sessionId, enqueuedAtMs: queued.enqueuedAtMs })}\n`);
    } else {
      // Says the id, because `drop` needs it and a message that cannot be
      // retracted is a message that cannot be taken back.
      ctx.stdout(
        `queued for session ${options.sessionId} as ${queued.id} (${queued.text.length} chars, starts when it goes idle)\n`,
      );
    }

    return EXIT_CODES.OK;
  } finally {
    await queue.release();
  }
}

export async function handleQueueList(ctx: CliContext, options: QueueListOptions): Promise<ExitCode> {
  const queue = queueOf(ctx, options.sessionId);
  try {
    const got = unwrap(await queue.list(0, options.limit));
    if ("code" in got) {
      return refuse(ctx, got.code);
    }

    const page = got.value;

    if (options.json) {
      ctx.stdout(`${JSON.stringify({ ok: true, sessionId: options.sessionId, total: page.total, items: page.items })}\n`);
      return EXIT_CODES.OK;
    }

    if (page.total === 0) {
      // An empty queue here is a real, checkable state, and it is reported as
      // one: "0 queued" is what a person needs to hear to stop worrying.
      ctx.stdout(`nothing queued for session ${options.sessionId}\n`);
      return EXIT_CODES.OK;
    }

    for (const item of page.items) {
      const oneLine = item.text.replace(/\s+/g, " ").trim();
      ctx.stdout(`${item.id}  ${relativeTime(item.enqueuedAtMs, ctx.now())}  ${oneLine}\n`);
    }

    // The total is printed even when the page is full, so a truncated listing
    // cannot read as "that is all of them".
    if (page.total > page.items.length) {
      ctx.stdout(`showing ${page.items.length} of ${page.total}; --limit ${options.limit * 2} for more\n`);
    }

    return EXIT_CODES.OK;
  } finally {
    await queue.release();
  }
}

export async function handleQueueDrop(ctx: CliContext, options: QueueDropOptions): Promise<ExitCode> {
  const queue = queueOf(ctx, options.sessionId);
  try {
    const got = unwrap(await queue.delete(options.id));
    if ("code" in got) {
      return refuse(ctx, got.code);
    }

    if (options.json) {
      ctx.stdout(`${JSON.stringify({ ok: true, dropped: options.id, sessionId: options.sessionId })}\n`);
    } else {
      ctx.stdout(`dropped ${options.id}; it will not be sent\n`);
    }

    return EXIT_CODES.OK;
  } finally {
    await queue.release();
  }
}

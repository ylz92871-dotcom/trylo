import { flagToken, readValue, usageError } from "./args-tokens.js";
import type { ParsedCommand } from "./args-primitives.js";
import { familyHelpCommand } from "./usage.js";
import { isValidSessionId } from "./session-paths.js";

/**
 * `queue` argument parsing — messages for a session that is not listening yet.
 *
 * Codex's CLI face is one verb (`codex queue --thread <T> --message <M>`); the
 * other five queue operations live behind RPCs it marks Experimental. Two of
 * those are here anyway, and the reason is not feature appetite:
 *
 *  - **`list`** — a queue a person cannot see is a queue they cannot trust. They
 *    typed a message into a second terminal and got back one line of
 *    acknowledgement; without `list`, "is it still queued?" has no answer, and
 *    the honest fallback is to send it again, which is how duplicates happen.
 *  - **`drop`** — a message queued by mistake has to be retractable by the same
 *    person, or the only way to unsay it is to let the session start a turn on
 *    it. Retracting is strictly less bad than answering.
 *
 * The session id is validated here rather than at the store, using the same
 * predicate that decides whether an id can be a filename. A queue path is
 * derived from that id, so an id containing `..` would be a path that escapes
 * the queue directory — the same argument `session-paths.ts` already makes for
 * journals, and it is checked here so the refusal is a usage error the person
 * sees before anything is created.
 *
 * `--message` is a flag and not a positional, so a message that begins with a
 * dash (`--message --force`) is a value rather than a mystery flag.
 */

export type QueueAddOptions = {
  readonly sessionId: string;
  readonly text: string;
  readonly json: boolean;
};

export type QueueListOptions = {
  readonly sessionId: string;
  readonly json: boolean;
  readonly limit: number;
};

export type QueueDropOptions = {
  readonly sessionId: string;
  readonly id: string;
  readonly json: boolean;
};

const ADD_HINT = "try `trylo queue add --session <id> --message <text>`";
const LIST_HINT = "try `trylo queue list --session <id> [--json]`";
const DROP_HINT = "try `trylo queue drop --session <id> --id <queued-id>`";

/** One page of the queue, so `list` cannot be asked to print a thousand messages. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * A whole number, or nothing at all.
 *
 * `Number.parseInt("2.5")` is 2, and `parseInt("20 messages")` is 20. Both would
 * be a limit the person did not type, quietly applied to a listing they then
 * read as complete — so a trailing anything is refused rather than rounded away.
 */
function readWholeNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  return Number.parseInt(value, 10);
}

export function parseQueue(argv: ReadonlyArray<string>): ParsedCommand {
  const sub = argv[0];
  if (sub === "--help" || sub === "-h") {
    return familyHelpCommand("queue");
  }

  if (sub === undefined) {
    return usageError("queue requires a subcommand", LIST_HINT);
  }

  if (sub === "add") {
    return parseQueueAdd(argv.slice(1));
  }

  if (sub === "list") {
    return parseQueueList(argv.slice(1));
  }

  if (sub === "drop") {
    return parseQueueDrop(argv.slice(1));
  }

  return usageError(
    `unknown queue subcommand: ${sub}`,
    "try `trylo queue add|list|drop`",
  );
}

function parseQueueAdd(argv: ReadonlyArray<string>): ParsedCommand {
  let sessionId: string | undefined;
  let text: string | undefined;
  let json = false;
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      return familyHelpCommand("queue");
    }

    if (token === "--json") {
      json = true;
      index += 1;
      continue;
    }

    const flag = flagToken(token);
    if (flag === undefined) {
      return usageError(`queue add does not accept ${token}`, ADD_HINT);
    }

    if (flag.name === "session") {
      const read = readValue(argv, index, flag.inlineValue);
      if (read.error !== undefined) {
        return usageError(`option --session ${read.error}`, ADD_HINT);
      }

      sessionId = read.value;
      index = read.next;
      continue;
    }

    if (flag.name === "message") {
      const read = readValue(argv, index, flag.inlineValue);
      if (read.error !== undefined) {
        return usageError(`option --message ${read.error}`, ADD_HINT);
      }

      text = read.value;
      index = read.next;
      continue;
    }

    return usageError(`queue add does not accept --${flag.name}`, ADD_HINT);
  }

  const target = requireSessionId(sessionId, ADD_HINT);
  if (typeof target !== "string") {
    return target;
  }

  if (text === undefined || text.trim().length === 0) {
    return usageError("queue add requires a non-empty --message", ADD_HINT);
  }

  return { kind: "queue_add", options: { sessionId: target, text, json } };
}

function parseQueueList(argv: ReadonlyArray<string>): ParsedCommand {
  let sessionId: string | undefined;
  let json = false;
  let limit = DEFAULT_LIMIT;
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      return familyHelpCommand("queue");
    }

    if (token === "--json") {
      json = true;
      index += 1;
      continue;
    }

    const flag = flagToken(token);
    if (flag === undefined) {
      return usageError(`queue list does not accept ${token}`, LIST_HINT);
    }

    if (flag.name === "session") {
      const read = readValue(argv, index, flag.inlineValue);
      if (read.error !== undefined) {
        return usageError(`option --session ${read.error}`, LIST_HINT);
      }

      sessionId = read.value;
      index = read.next;
      continue;
    }

    if (flag.name === "limit") {
      const read = readValue(argv, index, flag.inlineValue);
      const parsed = read.error === undefined ? readWholeNumber(read.value) : undefined;
      if (parsed === undefined || parsed <= 0 || parsed > MAX_LIMIT) {
        return usageError(`option --limit must be a whole number from 1 to ${MAX_LIMIT}`, LIST_HINT);
      }

      limit = parsed;
      index = read.next;
      continue;
    }

    return usageError(`queue list does not accept --${flag.name}`, LIST_HINT);
  }

  const target = requireSessionId(sessionId, LIST_HINT);
  if (typeof target !== "string") {
    return target;
  }

  return { kind: "queue_list", options: { sessionId: target, json, limit } };
}

function parseQueueDrop(argv: ReadonlyArray<string>): ParsedCommand {
  let sessionId: string | undefined;
  let id: string | undefined;
  let json = false;
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      return familyHelpCommand("queue");
    }

    if (token === "--json") {
      json = true;
      index += 1;
      continue;
    }

    const flag = flagToken(token);
    if (flag === undefined) {
      return usageError(`queue drop does not accept ${token}`, DROP_HINT);
    }

    if (flag.name === "session") {
      const read = readValue(argv, index, flag.inlineValue);
      if (read.error !== undefined) {
        return usageError(`option --session ${read.error}`, DROP_HINT);
      }

      sessionId = read.value;
      index = read.next;
      continue;
    }

    if (flag.name === "id") {
      const read = readValue(argv, index, flag.inlineValue);
      if (read.error !== undefined || (read.value ?? "").trim().length === 0) {
        return usageError(`option --id ${read.error ?? "requires a non-empty value"}`, DROP_HINT);
      }

      id = read.value;
      index = read.next;
      continue;
    }

    return usageError(`queue drop does not accept --${flag.name}`, DROP_HINT);
  }

  if (id === undefined) {
    return usageError("queue drop requires --id", DROP_HINT);
  }

  const target = requireSessionId(sessionId, DROP_HINT);
  if (typeof target !== "string") {
    return target;
  }

  return { kind: "queue_drop", options: { sessionId: target, id, json } };
}

/**
 * Refuses an id that could not be a queue file, in the same words everywhere.
 *
 * Returns the id or the command to return — never a string that is quietly an
 * error object, because `usageError` hands back a `ParsedCommand` and a helper
 * typed as `string` would let one be spliced into a session path. Validating
 * here rather than in the store means the person gets a usage error with a hint,
 * instead of a refusal from the filesystem whose message would be about a path
 * they never typed.
 */
function requireSessionId(
  value: string | undefined,
  hint: string,
): string | ParsedCommand {
  if (value === undefined) {
    return usageError("this command requires --session <id>", hint);
  }

  const trimmed = value.trim();
  if (!isValidSessionId(trimmed)) {
    return usageError(
      `not a usable session id: ${trimmed}`,
      "a session id is letters, digits, dot, dash or underscore, and never contains ..",
    );
  }

  return trimmed;
}

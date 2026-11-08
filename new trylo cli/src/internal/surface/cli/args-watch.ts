import type { ParsedCommand } from "./args-primitives.js";
import type { WatchTrigger } from "../../ports/watch.js";

/**
 * `watch` argument parsing — sleeping until something happens (WP26 / A07).
 *
 * Five verbs: `add`, `list`, `cancel`, `check`, `forget`. `check` exists
 * because otherwise the only way to observe a condition is to wait for the
 * daemon to fire it, and a thing nobody can dry-run is a thing nobody can
 * trust. `forget` exists because a terminal watch (fired/cancelled) is a
 * record, and a record nobody can drop is a leak.
 *
 * ## Why this file mirrors `args-schedule.ts`
 *
 * The schedule parser returns the two shapes `args-primitives.ts` already has
 * (`family_help` and `error`) and lets the handler read raw argv. This parser
 * does the same for the same reason: the `ParsedCommand` union is owned
 * elsewhere, and growing it for five verbs would couple this family to that
 * file's edit. The option types below are the real contract, validated here
 * rather than downstream, so a bad `--at` is still a usage error the person
 * sees before any file is touched.
 *
 * ## The trigger selectors, and why exactly one is required
 *
 * A watch waits for one thing: a file to exist, a file to contain a string, a
 * command to have exited with a code, a flag to be set, or a wall-clock moment
 * (`--at` absolute, `--in` relative). Zero selectors means "wait for nothing",
 * and two means "wait for which?" — both are refused before anything is armed.
 * `--file-contains` additionally needs `--needle`, because "contains" without
 * the string is the same as "exists" misspelled.
 */

export type WatchAddTrigger =
  | { readonly kind: "file_exists"; readonly relativePath: string }
  | { readonly kind: "file_contains"; readonly relativePath: string; readonly needle: string }
  | { readonly kind: "command_exit"; readonly exitCode: number }
  | { readonly kind: "flag_set"; readonly flag: string }
  | { readonly kind: "deadline_at"; readonly atText: string }
  | { readonly kind: "deadline_in"; readonly inText: string };

export type WatchAddOptions = {
  readonly message: string;
  readonly sessionId: string;
  readonly trigger: WatchAddTrigger;
  readonly fireNow: boolean;
  readonly json: boolean;
};

export type WatchListOptions = {
  readonly sessionId: string | undefined;
  readonly json: boolean;
};

export type WatchCancelOptions = {
  readonly watchId: string;
  readonly json: boolean;
};

export type WatchCheckOptions = {
  readonly watchId: string;
  readonly json: boolean;
};

export type WatchForgetOptions = {
  readonly watchId: string;
  readonly json: boolean;
};

export type WatchVerb =
  | { readonly verb: "add"; readonly options: WatchAddOptions }
  | { readonly verb: "list"; readonly options: WatchListOptions }
  | { readonly verb: "cancel"; readonly options: WatchCancelOptions }
  | { readonly verb: "check"; readonly options: WatchCheckOptions }
  | { readonly verb: "forget"; readonly options: WatchForgetOptions };

/**
 * What the parser can answer with.
 *
 * `error` is distinct from `help` on purpose, for the same reason the
 * schedule parser states: a malformed watch id is a mistake about the id
 * shape, and answering it with general help reads as "re-read the manual"
 * rather than "that is not an id".
 */
export type WatchParse =
  | WatchVerb
  | { readonly verb: "help" }
  | { readonly verb: "error"; readonly message: string; readonly hint: string };

const WATCH_ID = /^w_[0-9a-f]+$/;

/**
 * Validate a watch id before it reaches a lookup.
 *
 * The same shape the daemon mints (`w_` plus hex, see `daemon-main.ts`). A
 * typo is a usage error here rather than a `watch_not_found` that reads like
 * the watch vanished.
 */
export function isValidWatchId(value: string): boolean {
  return WATCH_ID.test(value);
}

/**
 * Parse the argv after the `watch` family word.
 *
 * `--message` and `--session` are flags rather than positionals so a message
 * that begins with a dash is a value rather than a mystery flag — the
 * reasoning `args-queue.ts` already gives for `--message`.
 */
export function parseWatch(argv: ReadonlyArray<string>): WatchParse {
  const [verb, ...rest] = argv;

  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    return { verb: "help" };
  }

  if (verb === "add") {
    return parseAdd(rest);
  }

  if (verb === "list" || verb === "ls") {
    return parseList(rest);
  }

  if (verb === "cancel") {
    return parseIdVerb(rest, "cancel");
  }

  if (verb === "check") {
    return parseIdVerb(rest, "check");
  }

  if (verb === "forget") {
    return parseIdVerb(rest, "forget");
  }

  return {
    verb: "error",
    message: `unknown subcommand 'watch ${verb}'`,
    hint: "expected add, list, cancel, check or forget",
  };
}

function parseAdd(argv: ReadonlyArray<string>): WatchParse {
  const message = valueOf(argv, "message");
  if (message === undefined) {
    return { verb: "error", message: "watch add needs --message <text>", hint: "the text to hand the session when it fires" };
  }

  const session = valueOf(argv, "session");
  if (session === undefined) {
    return { verb: "error", message: "watch add needs --session <id>", hint: "the session the message goes to" };
  }

  const trigger = readTrigger(argv);
  if ("verb" in trigger) {
    return trigger;
  }

  return {
    verb: "add",
    options: {
      message,
      sessionId: session,
      trigger: trigger.trigger,
      fireNow: hasFlag(argv, "fire-now"),
      json: hasFlag(argv, "json"),
    },
  };
}

function parseList(argv: ReadonlyArray<string>): WatchParse {
  let session: string | undefined;
  let json = false;
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--json") {
      json = true;
      index += 1;
      continue;
    }

    if (token === "--session" || token.startsWith("--session=")) {
      const value = valueOf(argv.slice(index), "session");

      // valueOf on the suffix finds this occurrence; a bare --session with no
      // value is "not supplied" here and becomes "all sessions" — the store,
      // not the parser, owns the not_a_session refusal for `add`.
      session = value;
      index += value === undefined ? 1 : (token.includes("=") ? 1 : 2);
      continue;
    }

    if (token.startsWith("--")) {
      return { verb: "error", message: `watch list does not accept ${token}`, hint: "try `trylo watch list [--session <id>] [--json]`" };
    }

    return { verb: "error", message: `watch list does not accept ${token}`, hint: "try `trylo watch list [--session <id>] [--json]`" };
  }

  return { verb: "list", options: { sessionId: session, json } };
}

function parseIdVerb(argv: ReadonlyArray<string>, verb: "cancel" | "check" | "forget"): WatchParse {
  const inline = valueOf(argv, "id");
  const positional = argv.find((token) => !token.startsWith("--"));
  const id = inline ?? positional;
  if (id === undefined) {
    return { verb: "error", message: `watch ${verb} needs a watch id`, hint: "run `trylo watch list` to see the ids" };
  }

  if (!isValidWatchId(id)) {
    return {
      verb: "error",
      message: `'${id}' is not a watch id`,
      hint: "expected w_ followed by hex characters, as printed by `trylo watch list`",
    };
  }

  const json = hasFlag(argv, "json");

  if (verb === "cancel") {
    return { verb: "cancel", options: { watchId: id, json } };
  }

  if (verb === "check") {
    return { verb: "check", options: { watchId: id, json } };
  }

  return { verb: "forget", options: { watchId: id, json } };
}

/**
 * Read exactly one trigger selector.
 *
 * Counts selectors rather than chaining `if/else`, because the error when two
 * are present must name the real problem ("pick one") rather than silently
 * preferring the first — a silent preference is how `--at` plus `--flag`
 * becomes a watch that waits for the wrong thing.
 */
function readTrigger(argv: ReadonlyArray<string>): { readonly trigger: WatchAddTrigger } | { readonly verb: "error"; readonly message: string; readonly hint: string } {
  const fileExists = valueOf(argv, "file-exists");
  const fileContains = valueOf(argv, "file-contains");
  const needle = valueOf(argv, "needle");
  const exitCode = valueOf(argv, "exit-code");
  const flag = valueOf(argv, "flag");
  const at = valueOf(argv, "at");
  const within = valueOf(argv, "in");
  const picked = [fileExists, fileContains, exitCode, flag, at, within].filter((item) => item !== undefined).length;
  if (picked === 0) {
    return {
      verb: "error",
      message: "watch add needs one trigger: --file-exists, --file-contains, --exit-code, --flag, --at or --in",
      hint: "see `trylo watch`",
    };
  }

  if (picked > 1) {
    return {
      verb: "error",
      message: "watch add accepts exactly one trigger",
      hint: "pick one of --file-exists, --file-contains, --exit-code, --flag, --at, --in",
    };
  }

  if (fileExists !== undefined) {
    if (fileExists.trim().length === 0) {
      return { verb: "error", message: "--file-exists needs a path", hint: "pass the workspace-relative file to wait for" };
    }
    return { trigger: { kind: "file_exists", relativePath: fileExists } };
  }

  if (fileContains !== undefined) {
    if (fileContains.trim().length === 0) {
      return { verb: "error", message: "--file-contains needs a path", hint: "pass the workspace-relative file to wait on" };
    }

    if (needle === undefined || needle.length === 0) {
      return { verb: "error", message: "--file-contains needs --needle <text>", hint: "the string the file must contain" };
    }

    return { trigger: { kind: "file_contains", relativePath: fileContains, needle } };
  }

  if (exitCode !== undefined) {
    const parsed = Number.parseInt(exitCode, 10);
    if (!/^-?\d+$/.test(exitCode) || !Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
      return { verb: "error", message: "--exit-code must be 0-255", hint: "the command exit code to wait for" };
    }
    return { trigger: { kind: "command_exit", exitCode: parsed } };
  }

  if (flag !== undefined) {
    if (flag.trim().length === 0) {
      return { verb: "error", message: "--flag needs a name", hint: "the flag a session sets when the thing is true" };
    }
    return { trigger: { kind: "flag_set", flag } };
  }

  if (at !== undefined) {
    return { trigger: { kind: "deadline_at", atText: at } };
  }

  return { trigger: { kind: "deadline_in", inText: within as string } };
}

/** Whether `--<name>` (or `--<name>=…`) appears. */
function hasFlag(argv: ReadonlyArray<string>, name: string): boolean {
  return argv.some((token) => token === `--${name}` || token.startsWith(`--${name}=`));
}

/**
 * The value of `--<name>`, whether written `--name value` or `--name=value`.
 *
 * Returns `undefined` for a bare `--name` with no value, which the callers
 * treat as "not supplied" rather than as an empty string — the distinction
 * that lets a missing `--message` and a blank one take different paths (the
 * blank one reaches the store and comes back as `blank_text`).
 */
function valueOf(argv: ReadonlyArray<string>, name: string): string | undefined {
  for (const [index, token] of argv.entries()) {
    if (token === `--${name}`) {
      const next = argv[index + 1];
      return next !== undefined && !next.startsWith("--") ? next : undefined;
    }

    const prefix = `--${name}=`;
    if (token.startsWith(prefix)) {
      const inline = token.slice(prefix.length);
      return inline.length > 0 ? inline : undefined;
    }
  }
  return undefined;
}

/**
 * Resolve an `add` trigger to the port shape, using `nowMs` for `--in`.
 *
 * Pure apart from the clock argument: `--at` is `Date.parse` (deterministic
 * for a fixed string), `--in` is arithmetic. Pastness is not checked here —
 * a past `--at` reaches the store and comes back as `invalid_deadline`, which
 * is the mapping the contract requires.
 */
export function resolveWatchTrigger(
  nowMs: number,
  trigger: WatchAddTrigger,
): { readonly trigger: WatchTrigger } | { readonly verb: "error"; readonly message: string; readonly hint: string } {
  switch (trigger.kind) {
    case "file_exists":
      return { trigger: { kind: "condition", condition: { kind: "file_exists", relativePath: trigger.relativePath } } };
    case "file_contains":
      return {
        trigger: {
          kind: "condition",
          condition: { kind: "file_contains", relativePath: trigger.relativePath, needle: trigger.needle },
        },
      };
    case "command_exit":
      return { trigger: { kind: "condition", condition: { kind: "command_exit", exitCode: trigger.exitCode } } };
    case "flag_set":
      return { trigger: { kind: "condition", condition: { kind: "flag_set", flag: trigger.flag } } };
    case "deadline_at": {
      const atMs = parseAtMs(trigger.atText);
      if (atMs === undefined) {
        return { verb: "error", message: `--at '${trigger.atText}' is not a time`, hint: "pass ISO-8601 (2026-10-08T12:00:00Z) or epoch ms" };
      }
      return { trigger: { kind: "deadline", atMs } };
    }
    case "deadline_in": {
      const durationMs = parseInMs(trigger.inText);
      if (durationMs === undefined) {
        return { verb: "error", message: `--in '${trigger.inText}' is not a duration`, hint: "pass like 10s, 5m, 2h, 1d, or ms" };
      }
      return { trigger: { kind: "deadline", atMs: nowMs + durationMs } };
    }
  }
}

/** Parse `--at`: epoch ms when all digits, ISO-8601 otherwise. */
function parseAtMs(text: string): number | undefined {
  if (/^[0-9]+$/.test(text)) {
    const numeric = Number(text);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse `--in`: `<n>[ms|s|m|h|d]`, bare number means ms. */
function parseInMs(text: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(text);
  if (match === null) {
    return undefined;
  }

  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000;
  const total = amount * factor;

  return Number.isFinite(total) && total > 0 ? total : undefined;
}

export type { ParsedCommand };

import type { ParsedCommand } from "./args-primitives.js";

/**
 * `schedule` argument parsing — work that runs later without a person watching.
 *
 * Four verbs: `add`, `list`, `remove`, `run`. `run` exists because otherwise the
 * only way to observe the scheduler is to wait, and a thing nobody can observe is
 * a thing nobody can trust.
 *
 * ## Why this file adds nothing to `ParsedCommand`
 *
 * `args-primitives.ts` owns the union every command parses into, and it is under
 * another package's edit at the moment. Rather than grow the union for four verbs
 * this package will consume through its own dispatch, the parser returns the two
 * shapes that union already has — `family_help` and `error` — and the handler
 * reads the raw argv for the options. That keeps the write set disjoint without
 * inventing a second parse path, and when the union does grow these kinds become
 * one line each.
 *
 * The trade is explicit: the option types below are the real contract, and they
 * are validated here rather than downstream, so a bad `--cron` is still a usage
 * error the person sees before any file is touched.
 */

export type ScheduleAddOptions = {
  readonly cron: string;
  readonly prompt: string;
  readonly recurring: boolean;
  readonly durable: boolean;
  readonly wait: boolean;
  readonly sessionId: string | undefined;
  readonly json: boolean;
};

export type ScheduleListOptions = {
  readonly json: boolean;
};

export type ScheduleRemoveOptions = {
  readonly scheduleId: string;
  readonly json: boolean;
};

export type ScheduleRunOptions = {
  readonly json: boolean;
};

export type ScheduleVerb =
  | { readonly verb: "add"; readonly options: ScheduleAddOptions }
  | { readonly verb: "list"; readonly options: ScheduleListOptions }
  | { readonly verb: "remove"; readonly options: ScheduleRemoveOptions }
  | { readonly verb: "run"; readonly options: ScheduleRunOptions };

/**
 * What the parser can answer with.
 *
 * `error` is distinct from `help` on purpose: a malformed schedule id is a
 * mistake the person made, and answering it with the general help text — which
 * is what a bare unknown verb gets — reads as "here is how to use this" rather
 * than "that is not an id". Collapsing the two is how a typo turns into a person
 * re-reading the manual instead of fixing the argument.
 */
export type ScheduleParse =
  | ScheduleVerb
  | { readonly verb: "help" }
  | { readonly verb: "error"; readonly message: string; readonly hint: string };

const SCHEDULE_ID = /^sch_[0-9a-f]{8}$/;

/**
 * Validate a schedule id before it reaches a lookup.
 *
 * The same shape the store mints. Checking it here means a typo is a usage error
 * the person sees immediately, rather than an `unknown_schedule` that reads like
 * the schedule vanished.
 */
export function isValidScheduleId(value: string): boolean {
  return SCHEDULE_ID.test(value);
}

/**
 * Parse the argv after the `schedule` family word.
 *
 * `--cron` and `--prompt` are flags rather than positionals so a prompt that
 * begins with a dash is a value rather than a mystery flag — the reasoning
 * `args-queue.ts` already gives for `--message`.
 */
export function parseSchedule(argv: ReadonlyArray<string>): ScheduleParse {
  const [verb, ...rest] = argv;

  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    return { verb: "help" };
  }

  if (verb === "add") {
    return parseAdd(rest);
  }

  if (verb === "list" || verb === "ls") {
    return { verb: "list", options: { json: hasFlag(rest, "json") } };
  }

  if (verb === "remove" || verb === "rm" || verb === "delete") {
    return parseRemove(rest);
  }

  if (verb === "run" || verb === "tick") {
    return { verb: "run", options: { json: hasFlag(rest, "json") } };
  }

  return {
    verb: "error",
    message: `unknown subcommand 'schedule ${verb}'`,
    hint: "expected add, list, remove or run",
  };
}

function parseAdd(argv: ReadonlyArray<string>): ScheduleParse {
  const cron = valueOf(argv, "cron");
  if (cron === undefined) {
    return { verb: "error", message: "schedule add needs --cron <expr>", hint: "see `trylo schedule`" };
  }

  const prompt = valueOf(argv, "prompt");
  if (prompt === undefined) {
    return { verb: "error", message: "schedule add needs --prompt <text>", hint: "the text to run when it fires" };
  }

  const session = valueOf(argv, "session");

  return {
    verb: "add",
    options: {
      cron,
      prompt,
      // Recurring unless `--once` says otherwise: the common case is "keep doing
      // this", so the flag name reads as the exception it is.
      recurring: !hasFlag(argv, "once"),
      // Durable only when asked. A schedule that outlives this process is a
      // standing promise to spend provider spend unattended, so it is opt-in.
      durable: hasFlag(argv, "durable"),
      wait: hasFlag(argv, "wait"),
      sessionId: session,
      json: hasFlag(argv, "json"),
    },
  };
}

function parseRemove(argv: ReadonlyArray<string>): ScheduleParse {
  const inline = valueOf(argv, "id");
  const positional = argv.find((token) => !token.startsWith("--"));
  const id = inline ?? positional;
  if (id === undefined) {
    return { verb: "error", message: "schedule remove needs a schedule id", hint: "run `trylo schedule list` to see the ids" };
  }

  if (!isValidScheduleId(id)) {
    // The id never reaches a lookup, so the person is told the real problem
    // rather than an `unknown_schedule` that reads like the schedule vanished.
    return {
      verb: "error",
      message: `'${id}' is not a schedule id`,
      hint: "expected sch_ followed by 8 hex characters, as printed by `trylo schedule list`",
    };
  }

  return { verb: "remove", options: { scheduleId: id, json: hasFlag(argv, "json") } };
}

/** Whether `--<name>` (or `--<name>=…`) appears. */
function hasFlag(argv: ReadonlyArray<string>, name: string): boolean {
  return argv.some((token) => token === `--${name}` || token.startsWith(`--${name}=`));
}

/**
 * The value of `--<name>`, whether written `--name value` or `--name=value`.
 *
 * Returns `undefined` for a bare `--name` with no value, which the callers treat
 * as "not supplied" rather than as an empty prompt — a distinction that matters,
 * because an empty prompt is refused downstream with a message about the prompt.
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

export type { ParsedCommand };

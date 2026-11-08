import { flagToken, parsePositiveInt, readValue, usageError } from "./args-tokens.js";
import type { ParsedCommand } from "./args-primitives.js";
import { familyHelpCommand } from "./usage.js";

/**
 * `diff` and `review` argument parsing (WP11).
 *
 * `diff` is the read-only workspace diff (`/diff` headless): it never writes,
 * never stages, and reports "not a git repository" instead of failing. The
 * targets `review` accepts mirror Codex `ReviewArgs` — `--uncommitted`,
 * `--base`, `--commit [--title]`, or a positional prompt — so the conflict
 * rules in `review-target.ts` stay the single implementation of them.
 */

export type DiffCommandOptions = {
  readonly json: boolean;
};

export type ReviewCommandOptions = {
  readonly uncommitted: boolean;
  readonly base?: string;
  readonly commit?: string;
  readonly commitTitle?: string;
  readonly prompt?: string;
  /** A lone `-` positional: read the custom prompt from stdin (Codex parity). */
  readonly promptFromStdin?: boolean;
  readonly json: boolean;
};

const DIFF_HINT = "try `trylo diff [--json]`";
const REVIEW_HINT =
  "try `trylo review --uncommitted`, `trylo review --base <branch>`, `trylo review --commit <sha> [--title <text>]`, `trylo review \"<instructions>\"`, or `trylo review -` to read the instructions from stdin";
const SESSION_REVIEW_HINT =
  "try `trylo session review <id> [--turn <turn-id> | --message <n>] [--as-of-sequence <n>] [--json]`";

/**
 * `session review <id>`: one turn's durable facts — transcript, tool
 * outcomes, file writes, checkpoints and unproven effects — plus an optional
 * rollback-horizon preview. Read-only: the journal is never rewritten;
 * rolling back is `session fork`, rewinding files is `checkpoint restore`.
 *
 * Lives here rather than `args-session.ts` for the file-size discipline; the
 * session family routes to it, so the surface vocabulary is unchanged.
 */
export type SessionReviewOptions = {
  readonly session: string;
  readonly turn?: string;
  readonly message?: number;
  readonly asOfSequence?: number;
  readonly json: boolean;
};

export function parseDiff(argv: ReadonlyArray<string>): ParsedCommand {
  let json = false;

  for (const token of argv) {
    if (token === "--help" || token === "-h") {
      return { kind: "help" };
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    return usageError(`diff does not accept ${token}`, DIFF_HINT);
  }

  return { kind: "diff", options: { json } };
}

export function parseReview(argv: ReadonlyArray<string>): ParsedCommand {
  let json = false;
  let uncommitted = false;
  let base: string | undefined;
  let commit: string | undefined;
  let commitTitle: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      return { kind: "help" };
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "--uncommitted") {
      uncommitted = true;
      continue;
    }

    const flag = flagToken(token);
    if (flag === undefined) {
      positional.push(token);
      continue;
    }

    if (flag.name !== "base" && flag.name !== "commit" && flag.name !== "title") {
      return usageError(`review does not accept --${flag.name}`, REVIEW_HINT);
    }

    const read = readValue(argv, index, flag.inlineValue);
    if (read.error !== undefined || (read.value ?? "").trim().length === 0) {
      return usageError(`option --${flag.name} ${read.error ?? "requires a non-empty value"}`, REVIEW_HINT);
    }

    if (flag.name === "base") {
      base = read.value ?? "";
    } else if (flag.name === "commit") {
      commit = read.value ?? "";
    } else {
      commitTitle = read.value ?? "";
    }

    index = read.next - 1;
  }

  // Codex parity: a lone `-` reads the custom prompt from stdin instead of
  // using the dash as instructions. Any other shape (including `-` with
  // company) is literal prompt text.
  const promptFromStdin = positional.length === 1 && positional[0] === "-";
  const prompt = promptFromStdin || positional.join(" ").trim() === "" ? undefined : positional.join(" ").trim();

  return {
    kind: "review",
    options: {
      uncommitted,
      ...(base === undefined ? {} : { base }),
      ...(commit === undefined ? {} : { commit }),
      ...(commitTitle === undefined ? {} : { commitTitle }),
      ...(prompt === undefined || promptFromStdin ? {} : { prompt }),
      ...(promptFromStdin ? { promptFromStdin: true } : {}),
      json,
    },
  };
}

export function requireSessionId(argv: ReadonlyArray<string>, verb: string, hint: string): string | ParsedCommand {
  const session = argv[0];
  if (session === "--help" || session === "-h") {
    return familyHelpCommand("session");
  }

  if (session === undefined || session.startsWith("--")) {
    return usageError(`session ${verb} requires a session id`, hint);
  }

  return session;
}

/**
 * `session review <id> [--turn <turn-id> | --message <n>]
 * [--as-of-sequence <n>] [--json]`.
 *
 * `--turn` names a turn exactly; `--message` counts user messages the way a
 * person counts (shared numbering with `session fork --before-user-message`).
 * `--as-of-sequence` adds a rollback-horizon preview for a journal position.
 * Turn and message together would name two turns, so they conflict.
 */
export function parseSessionReview(argv: ReadonlyArray<string>): ParsedCommand {
  const required = requireSessionId(argv, "review", SESSION_REVIEW_HINT);
  if (typeof required !== "string") {
    return required;
  }

  let json = false;
  let turn: string | undefined;
  let message: number | undefined;
  let asOfSequence: number | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--json") {
      json = true;
      continue;
    }

    const flag = flagToken(token);
    if (flag === undefined) {
      return usageError(`session review does not accept ${token}`, SESSION_REVIEW_HINT);
    }

    const read = readValue(argv, index, flag.inlineValue);
    if (read.error !== undefined) {
      return usageError(`option --${flag.name} ${read.error}`, SESSION_REVIEW_HINT);
    }

    const raw = read.value ?? "";

    if (flag.name === "turn") {
      if (raw.trim().length === 0) {
        return usageError("option --turn requires a non-empty value", SESSION_REVIEW_HINT);
      }
      turn = raw;
    } else if (flag.name === "message") {
      message = parsePositiveInt(raw);
      if (message === undefined) {
        return usageError("option --message must be a positive integer", SESSION_REVIEW_HINT);
      }
    } else if (flag.name === "as-of-sequence") {
      if (!/^\d+$/.test(raw)) {
        return usageError("option --as-of-sequence must be a non-negative integer", SESSION_REVIEW_HINT);
      }
      asOfSequence = Number.parseInt(raw, 10);
    } else {
      return usageError(`session review does not accept --${flag.name}`, SESSION_REVIEW_HINT);
    }

    index = read.next - 1;
  }

  if (turn !== undefined && message !== undefined) {
    return usageError("--turn and --message cannot be used together", SESSION_REVIEW_HINT);
  }

  return {
    kind: "session_review",
    options: {
      session: required,
      ...(turn === undefined ? {} : { turn }),
      ...(message === undefined ? {} : { message }),
      ...(asOfSequence === undefined ? {} : { asOfSequence }),
      json,
    },
  };
}

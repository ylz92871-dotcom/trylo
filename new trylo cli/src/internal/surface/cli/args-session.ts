import {
  flagToken,
  parsePositiveInt,
  readValue,
  usageError,
} from "./args-tokens.js";
import {
  isSessionExportFormat,
  type ParsedCommand,
  type SessionExportFormat,
} from "./args-primitives.js";
import { parseSessionReview, requireSessionId } from "./args-review.js";
import { familyHelpCommand } from "./usage.js";

/**
 * `session` argument parsing.
 *
 * `list` is a read. `reconcile` is a read until it is given a verdict, and the
 * four verdict flags are all-or-nothing at parse time: a half-addressed
 * verdict is a usage error here rather than something the command layer has to
 * guess at.
 *
 * There is deliberately no `--yes`, no `--all` and no `unknown` outcome. The
 * set of things a session cannot prove is exactly the set of things the machine
 * could not find out, so the only way to shorten it is to name one action and
 * say what was checked.
 */

export type SessionReconcileOptions = {
  readonly session: string;
  readonly turn?: string;
  readonly key?: string;
  readonly outcome?: string;
  readonly evidence?: string;
  readonly json: boolean;
};

/** `session info <id>` and `session remove <id>`: one named session, nothing else. */
export type SessionTargetOptions = {
  readonly session: string;
  readonly json: boolean;
};

export type SessionForkOptions = {
  readonly session: string;
  readonly newId?: string;
  readonly beforeUserMessage?: number;
  readonly interrupted: boolean;
  readonly json: boolean;
};

export type SessionRenameOptions = {
  readonly session: string;
  readonly name: string;
};

export type SessionExportOptions = {
  readonly session: string;
  readonly format: SessionExportFormat;
};

export type SessionArchiveOptions = {
  readonly session: string;
  /** True for `archive`, false for `unarchive`: one shape, no second verb type. */
  readonly archived: boolean;
};

/** The flags that together make a verdict; any one of them demands all four. */
export const RECONCILE_VERDICT_FLAGS = ["turn", "key", "outcome", "evidence"] as const;

export type ReconcileVerdictFlag = (typeof RECONCILE_VERDICT_FLAGS)[number];

const LIST_HINT = "try `trylo session list [--json] [--search <text>] [--all]`";
const RECONCILE_HINT =
  "try `trylo session reconcile <id> [--json]`, or add --turn <t> --key <k> --outcome <committed|failed> --evidence <what you checked>";

export function parseSession(argv: ReadonlyArray<string>): ParsedCommand {
  const sub = argv[0];
  if (sub === "--help" || sub === "-h") {
    return familyHelpCommand("session");
  }

  if (sub === undefined) {
    return usageError("session requires a subcommand", "try `trylo session list` or `trylo session fork|info|rename|export|archive|remove|reconcile|review <id>`");
  }

  if (sub === "list") {
    return parseSessionList(argv.slice(1));
  }

  if (sub === "reconcile") {
    return parseSessionReconcile(argv.slice(1));
  }

  if (sub === "review") {
    return parseSessionReview(argv.slice(1));
  }

  if (sub === "info") {
    return parseSessionTarget(argv.slice(1), "info");
  }

  if (sub === "fork") {
    return parseSessionFork(argv.slice(1));
  }

  if (sub === "rename") {
    return parseSessionRename(argv.slice(1));
  }

  if (sub === "export") {
    return parseSessionExport(argv.slice(1));
  }

  if (sub === "archive" || sub === "unarchive") {
    return parseSessionArchive(argv.slice(1), sub === "archive");
  }

  if (sub === "remove") {
    return parseSessionTarget(argv.slice(1), "remove");
  }

  return usageError(
    `unknown session subcommand: ${sub}`,
    "try `trylo session list|info|fork|rename|export|archive|unarchive|remove|reconcile|review`",
  );
}

function parseSessionList(argv: ReadonlyArray<string>): ParsedCommand {
  let json = false;
  let all = false;
  let search: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      return familyHelpCommand("session");
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "--all") {
      all = true;
      continue;
    }

    const flag = flagToken(token);
    if (flag?.name === "search") {
      const read = readValue(argv, index, flag.inlineValue);
      if (read.error !== undefined || (read.value ?? "").trim().length === 0) {
        return usageError(`option --search ${read.error ?? "requires a non-empty value"}`, LIST_HINT);
      }

      search = read.value ?? "";
      index = read.next - 1;
      continue;
    }

    return usageError(`session list does not accept ${token}`, LIST_HINT);
  }

  return {
    kind: "session_list",
    json,
    ...(search === undefined ? {} : { search }),
    all,
  };
}

function parseSessionReconcile(argv: ReadonlyArray<string>): ParsedCommand {
  const session = argv[0];
  if (session === "--help" || session === "-h") {
    return familyHelpCommand("session");
  }

  if (session === undefined || session.startsWith("--")) {
    return usageError("session reconcile requires a session id", RECONCILE_HINT);
  }

  let json = false;
  const given = new Map<ReconcileVerdictFlag, string>();

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      return familyHelpCommand("session");
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    const flag = flagToken(token);
    if (flag === undefined || !(RECONCILE_VERDICT_FLAGS as readonly string[]).includes(flag.name)) {
      return usageError(`session reconcile does not accept ${token}`, RECONCILE_HINT);
    }

    const name = flag.name as ReconcileVerdictFlag;
    const read = readValue(argv, index, flag.inlineValue);
    if (read.error !== undefined) {
      return usageError(`option --${name} ${read.error}`, RECONCILE_HINT);
    }

    const value = read.value ?? "";
    if (value.trim().length === 0) {
      return usageError(`option --${name} requires a non-empty value`, RECONCILE_HINT);
    }

    given.set(name, value);
    index = read.next - 1;
  }

  const missing = RECONCILE_VERDICT_FLAGS.filter(flag => !given.has(flag));
  if (given.size > 0 && missing.length > 0) {
    return usageError(
      `a verdict needs ${missing.map(flag => `--${flag}`).join(", ")} as well`,
      RECONCILE_HINT,
    );
  }

  const turn = given.get("turn");
  const key = given.get("key");
  const outcome = given.get("outcome");
  const evidence = given.get("evidence");

  return {
    kind: "session_reconcile",
    options: {
      session,
      ...(turn === undefined ? {} : { turn }),
      ...(key === undefined ? {} : { key }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(evidence === undefined ? {} : { evidence }),
      json,
    },
  };
}

/** `session info <id>` and `session remove <id>`: one id, optional `--json`. */
function parseSessionTarget(argv: ReadonlyArray<string>, verb: "info" | "remove"): ParsedCommand {
  const hint = verb === "info"
    ? "try `trylo session info <id> [--json]`"
    : "try `trylo session remove <id> [--json]`";
  const required = requireSessionId(argv, verb, hint);
  if (typeof required !== "string") {
    return required;
  }

  let json = false;

  for (const token of argv.slice(1)) {
    if (token === "--json") {
      json = true;
      continue;
    }
    return usageError(`session ${verb} does not accept ${token}`, hint);
  }

  return { kind: verb === "info" ? "session_info" : "session_remove", options: { session: required, json } };
}

function parseSessionFork(argv: ReadonlyArray<string>): ParsedCommand {
  const hint = "try `trylo session fork <id> [--new-id <id>] [--before-user-message <n> | --interrupted] [--json]`";
  const required = requireSessionId(argv, "fork", hint);
  if (typeof required !== "string") {
    return required;
  }

  let json = false;
  let interrupted = false;
  let newId: string | undefined;
  let beforeUserMessage: number | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "--interrupted") {
      interrupted = true;
      continue;
    }

    const flag = flagToken(token);
    if (flag === undefined) {
      return usageError(`session fork does not accept ${token}`, hint);
    }

    const read = readValue(argv, index, flag.inlineValue);
    if (read.error !== undefined) {
      return usageError(`option --${flag.name} ${read.error}`, hint);
    }

    if (flag.name === "new-id") {
      newId = read.value ?? "";
      if (newId.trim().length === 0) {
        return usageError("option --new-id requires a non-empty value", hint);
      }
    } else if (flag.name === "before-user-message") {
      beforeUserMessage = parsePositiveInt(read.value ?? "");
      if (beforeUserMessage === undefined) {
        return usageError("option --before-user-message must be a positive integer", hint);
      }
    } else {
      return usageError(`session fork does not accept --${flag.name}`, hint);
    }

    index = read.next - 1;
  }

  if (interrupted && beforeUserMessage !== undefined) {
    return usageError("--before-user-message and --interrupted cannot be used together", hint);
  }

  return {
    kind: "session_fork",
    options: {
      session: required,
      ...(newId === undefined ? {} : { newId }),
      ...(beforeUserMessage === undefined ? {} : { beforeUserMessage }),
      interrupted,
      json,
    },
  };
}

function parseSessionRename(argv: ReadonlyArray<string>): ParsedCommand {
  const hint = "try `trylo session rename <id> <new name>`";
  const required = requireSessionId(argv, "rename", hint);
  if (typeof required !== "string") {
    return required;
  }

  const name = argv.slice(1).join(" ");
  if (name.trim().length === 0) {
    return usageError("session rename requires a new name", hint);
  }

  return { kind: "session_rename", options: { session: required, name } };
}

function parseSessionExport(argv: ReadonlyArray<string>): ParsedCommand {
  const hint = "try `trylo session export <id> [--format json|markdown]`";
  const required = requireSessionId(argv, "export", hint);
  if (typeof required !== "string") {
    return required;
  }

  let format: SessionExportFormat = "json";

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const flag = flagToken(token);
    if (flag?.name !== "format") {
      return usageError(`session export does not accept ${token}`, hint);
    }

    const read = readValue(argv, index, flag.inlineValue);
    if (read.error !== undefined) {
      return usageError(`option --format ${read.error}`, hint);
    }

    const raw = read.value ?? "";
    if (!isSessionExportFormat(raw)) {
      return usageError(`unknown export format: ${raw}`, hint);
    }

    format = raw;
    index = read.next - 1;
  }

  return { kind: "session_export", options: { session: required, format } };
}

function parseSessionArchive(argv: ReadonlyArray<string>, archived: boolean): ParsedCommand {
  const verb = archived ? "archive" : "unarchive";
  const hint = `try \`trylo session ${verb} <id>\``;
  const required = requireSessionId(argv, verb, hint);
  if (typeof required !== "string") {
    return required;
  }

  if (argv.length > 1) {
    return usageError(`session ${verb} does not accept ${argv[1] ?? ""}`, hint);
  }

  return { kind: "session_archive", options: { session: required, archived } };
}

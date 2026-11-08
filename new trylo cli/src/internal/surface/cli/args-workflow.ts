import type { ParsedCommand, RunCommandOptions } from "./args-primitives.js";
import { parseRun } from "./args-run.js";
import { flagToken, usageError } from "./args-tokens.js";
import { familyHelpCommand } from "./usage.js";
import { isStyleName } from "./output-styles.js";

/**
 * `workflow` argument parsing (WP24.2 / A08).
 *
 * `list` / `show` are read-only discovery. `run` resolves the named file
 * and delegates to the ordinary run parser for everything after `--`, so
 * every run flag keeps exactly the meaning it has on `trylo run` — the
 * workflow contributes a prompt, never a permission or a budget.
 */

export type WorkflowListOptions = {
  readonly json: boolean;
};

export type WorkflowShowOptions = {
  readonly name: string;
  readonly json: boolean;
};

export type WorkflowRunOptions = {
  readonly name: string;
  /** Explicit applicability context for a nominated learned Board version. */
  readonly task?: string;
  readonly run: RunCommandOptions;
};

const LIST_HINT = "try `trylo workflow list [--json]`";
const SHOW_HINT = "try `trylo workflow show <name> [--json]`";
const RUN_HINT = "try `trylo workflow run <name> [-- <run options>]`";

export function parseWorkflow(argv: ReadonlyArray<string>): ParsedCommand {
  const sub = argv[0];
  if (sub === "--help" || sub === "-h") {
    return familyHelpCommand("workflow");
  }

  if (sub === undefined) {
    return usageError("workflow requires a subcommand", LIST_HINT);
  }

  if (sub === "list") {
    return parseList(argv.slice(1));
  }

  if (sub === "show") {
    return parseShow(argv.slice(1));
  }

  if (sub === "run") {
    return parseWorkflowRun(argv.slice(1));
  }

  if (["learn", "learned", "inspect", "feedback", "jobs", "job", "recover", "retry", "work", "learn-session",
    "improvements", "improvement", "improve-work", "improve-user-feedback"].includes(sub)) {
    return { kind: "workflow_learning", args: argv };
  }

  return usageError(`unknown workflow subcommand: ${sub}`, "try `trylo workflow list|show|run`");
}

function readJsonTail(argv: ReadonlyArray<string>, hint: string): { readonly json: boolean } | ParsedCommand {
  let json = false;

  for (const token of argv) {
    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      return familyHelpCommand("workflow");
    }

    const flag = flagToken(token);
    if (flag !== undefined) {
      return usageError(`workflow does not accept --${flag.name} here`, hint);
    }

    return usageError(`workflow does not accept ${token} here`, hint);
  }

  return { json };
}

function requireName(positional: ReadonlyArray<string>, hint: string): string | ParsedCommand {
  if (positional.length !== 1 || positional[0] === undefined) {
    return usageError("a workflow subcommand takes exactly one workflow name", hint);
  }

  const name = positional[0];
  if (!isStyleName(name)) {
    return usageError(
      `not a usable workflow name: ${name}`,
      "a workflow name is a filename stem: letters, digits, dot, dash, underscore",
    );
  }

  return name;
}

function parseList(argv: ReadonlyArray<string>): ParsedCommand {
  const flags = readJsonTail(argv, LIST_HINT);
  if ("kind" in flags) {
    return flags;
  }
  return { kind: "workflow_list", options: { json: flags.json } };
}

function parseShow(argv: ReadonlyArray<string>): ParsedCommand {
  const positional = argv.filter((token) => !token.startsWith("--"));
  const flags = readJsonTail(
    argv.filter((token) => token.startsWith("--")),
    SHOW_HINT,
  );
  if ("kind" in flags) {
    return flags;
  }

  const name = requireName(positional, SHOW_HINT);
  if (typeof name !== "string") {
    return name;
  }

  return { kind: "workflow_show", options: { name, json: flags.json } };
}

function parseWorkflowRun(argv: ReadonlyArray<string>): ParsedCommand {
  if (argv.includes("--help") || argv.includes("-h")) {
    return familyHelpCommand("workflow");
  }

  const separator = argv.indexOf("--");
  const head = separator < 0 ? argv : argv.slice(0, separator);
  const tail = separator < 0 ? [] : argv.slice(separator + 1);
  const learned = head[0]?.startsWith("wfl_") === true;
  const task = learned && head[1] === "--task" ? head[2] : undefined;
  if (learned && (task === undefined || task.startsWith("--") || head.length !== 3)) {
    return usageError("learned workflow run requires --task <task.json>", "try `trylo workflow run <versionId> --task <task.json> -- <run options>`");
  }

  // The run parser continues to own all ordinary execution flags after --.
  for (const token of learned ? [] : head.slice(1)) {
    if (token.startsWith("--")) {
      return usageError(`workflow run does not accept ${token}; pass run flags after --`, RUN_HINT);
    }
    return usageError(`workflow run does not accept ${token}`, RUN_HINT);
  }

  const name = requireName(head.slice(0, 1), RUN_HINT);
  if (typeof name !== "string") {
    return name;
  }

  const parsed = parseRun(tail);
  if (parsed.kind !== "run") {
    return parsed;
  }

  return { kind: "workflow_run", options: { name, ...(task === undefined ? {} : { task }), run: parsed.options } };
}

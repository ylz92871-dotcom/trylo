import type { ParsedCommand } from "./args-primitives.js";
import { flagToken, usageError } from "./args-tokens.js";
import { familyHelpCommand } from "./usage.js";
import { isStyleName } from "./output-styles.js";

/**
 * `output-style` argument parsing (WP24.2 / L48).
 *
 * Read-only discovery over the loader: `list` names what `run
 * --output-style` can consume, `show` prints one prompt. Both take `--json`
 * for the machine consumer and nothing else.
 */

export type OutputStyleListOptions = {
  readonly json: boolean;
};

export type OutputStyleShowOptions = {
  readonly name: string;
  readonly json: boolean;
};

const LIST_HINT = "try `trylo output-style list [--json]`";
const SHOW_HINT = "try `trylo output-style show <name> [--json]`";

export function parseOutputStyle(argv: ReadonlyArray<string>): ParsedCommand {
  const sub = argv[0];
  if (sub === "--help" || sub === "-h") {
    return familyHelpCommand("output-style");
  }

  if (sub === undefined) {
    return usageError("output-style requires a subcommand", LIST_HINT);
  }

  if (sub === "list") {
    return parseList(argv.slice(1));
  }

  if (sub === "show") {
    return parseShow(argv.slice(1));
  }

  return usageError(`unknown output-style subcommand: ${sub}`, "try `trylo output-style list|show`");
}

function readJsonFlag(argv: ReadonlyArray<string>, hint: string): { readonly json: boolean } | ParsedCommand {
  let json = false;

  for (const token of argv) {
    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      return familyHelpCommand("output-style");
    }

    const flag = flagToken(token);
    if (flag !== undefined) {
      return usageError(`output-style does not accept --${flag.name}`, hint);
    }

    return usageError(`output-style does not accept ${token}`, hint);
  }

  return { json };
}

function parseList(argv: ReadonlyArray<string>): ParsedCommand {
  const flags = readJsonFlag(argv, LIST_HINT);
  if ("kind" in flags) {
    return flags;
  }
  return { kind: "output_style_list", options: { json: flags.json } };
}

function parseShow(argv: ReadonlyArray<string>): ParsedCommand {
  const positional = argv.filter((token) => !token.startsWith("--"));
  const flags = argv.filter((token) => token.startsWith("--"));
  const checked = readJsonFlag(flags, SHOW_HINT);
  if ("kind" in checked) {
    return checked;
  }

  if (positional.length !== 1 || positional[0] === undefined) {
    return usageError("output-style show requires exactly one style name", SHOW_HINT);
  }

  const name = positional[0];
  if (!isStyleName(name)) {
    return usageError(`not a usable style name: ${name}`, "a style name is a filename stem: letters, digits, dot, dash, underscore");
  }

  return { kind: "output_style_show", options: { name, json: checked.json } };
}

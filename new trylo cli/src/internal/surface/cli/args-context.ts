import type { ParsedCommand } from "./args-primitives.js";
import { flagToken, readValue, usageError } from "./args-tokens.js";
import { familyHelpCommand } from "./usage.js";
import { isValidSessionId } from "./session-paths.js";

/**
 * `context` argument parsing (WP24.2 / A08, context inspect/snip).
 *
 * Read-only inspection with no session write, no turn, no model call:
 * without `--session` it reports the workspace inputs a run would adopt
 * (project rules, via the same resolver runs use); with `--session` it
 * reports the journal-derived shape (turns, records, estimated tokens).
 * `--turn` narrows the journal view to one turn — the bounded slice the
 * old `HISTORY_SNIP` idea wanted, served from facts already on disk.
 */

export type ContextOptions = {
  readonly session?: string;
  readonly turn?: string;
  readonly json: boolean;
};

const HINT = "try `trylo context [--session <id> [--turn <turn-id>]] [--json]`";

export function parseContext(argv: ReadonlyArray<string>): ParsedCommand {
  let session: string | undefined;
  let turn: string | undefined;
  let json = false;
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      return familyHelpCommand("context");
    }

    if (token === "--json") {
      json = true;
      index += 1;
      continue;
    }

    const flag = flagToken(token);
    if (flag === undefined) {
      return usageError(`context does not accept ${token}`, HINT);
    }

    if (flag.name === "session" || flag.name === "turn") {
      const read = readValue(argv, index, flag.inlineValue);
      if (read.error !== undefined || (read.value ?? "").trim().length === 0) {
        return usageError(`option --${flag.name} ${read.error ?? "requires a non-empty value"}`, HINT);
      }

      const value = (read.value ?? "").trim();
      if (flag.name === "session" && !isValidSessionId(value)) {
        return usageError(
          `not a usable session id: ${value}`,
          "a session id is letters, digits, dot, dash or underscore, and never contains ..",
        );
      }

      if (flag.name === "session") {
        session = value;
      } else {
        turn = value;
      }

      index = read.next;
      continue;
    }

    return usageError(`context does not accept --${flag.name}`, HINT);
  }

  if (turn !== undefined && session === undefined) {
    return usageError("--turn needs --session", HINT);
  }

  return { kind: "context", options: { ...(session === undefined ? {} : { session }), ...(turn === undefined ? {} : { turn }), json } };
}

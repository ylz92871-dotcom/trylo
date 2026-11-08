import type { ParsedCommand } from "./args-primitives.js";
import { flagToken, usageError } from "./args-tokens.js";
import { familyHelpCommand } from "./usage.js";

/**
 * `update` argument parsing (WP24.1 / C86).
 *
 * The old CLI's `update` checks a release bucket and installs; this CLI
 * ships no release channel (no bucket, no installer, no auto-updater), so
 * the command is a check-only surface: `update --check` reports, bare
 * `update` names the missing channel instead of pretending to install.
 */

export type UpdateOptions = {
  /** Absent means "install", which this CLI cannot do — see the handler. */
  readonly check: boolean;
  readonly json: boolean;
};

const HINT = "try `trylo update --check [--json]`";

export function parseUpdate(argv: ReadonlyArray<string>): ParsedCommand {
  let check = false;
  let json = false;

  for (const token of argv) {
    if (token === "--help" || token === "-h") {
      return familyHelpCommand("update");
    }

    if (token === "--check") {
      check = true;
      continue;
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    const flag = token.startsWith("--") ? flagToken(token) : undefined;
    if (flag !== undefined) {
      return usageError(`update does not accept --${flag.name}`, HINT);
    }

    return usageError(`update does not accept ${token}`, HINT);
  }

  return { kind: "update", options: { check, json } };
}

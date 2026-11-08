import type { ParsedCommand } from "./args-primitives.js";
import { usageError } from "./args-tokens.js";

export type CollaborationIssueOptions = { readonly subsystem: "collaboration"; readonly control: "issues" | "coordinate"; readonly workspace?: string };

const HINT = "try `trylo learn collaboration issues --workspace ROOT --json` or `trylo learn collaboration coordinate --workspace ROOT -`";

export function parseCollaborationIssues(argv: readonly string[]): ParsedCommand {
  const control = argv[0];
  if (control !== "issues" && control !== "coordinate") return usageError("unknown collaboration control command", HINT);

  let workspace: string | undefined, json = false, stdin = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--json" && !json) {
      json = true;
      continue;
    }

    if (arg === "-" && !stdin && control === "coordinate") {
      stdin = true;
      continue;
    }

    if (arg === "--workspace" && workspace === undefined) {
      const next = argv[++index];
      if (next !== undefined && next.trim() && next.length <= 4096 && !next.startsWith("--") && !/[\u0000-\u001f]/u.test(next)) {
        workspace = next;
        continue;
      }
    }

    return usageError("invalid or duplicate collaboration control option", HINT);
  }

  if (control === "coordinate" && !stdin) return usageError("coordinate requires JSON from stdin using '-'", HINT);

  return { kind: "learn", options: { subsystem: "collaboration", control, ...(workspace === undefined ? {} : { workspace }) } };
}

import type { ParsedCommand } from "./args-primitives.js";
import { flagToken, usageError } from "./args-tokens.js";
import { familyHelpCommand } from "./usage.js";

/**
 * `memory` command family (WP-CL / B17).
 *
 * Two read/write verbs over the formal user ledger:
 *
 *  - `list [--json]` — what this machine currently remembers, newest first;
 *  - `import --file <path> [--json]` — idempotent import of a panel export.
 *
 * The import takes a **file**, not argv: a legacy snapshot can be large, and a
 * statement in argv ends up in process listings and shell history. There is no
 * `--force`: re-running is already idempotent, and a flag that could overwrite
 * a newer edit is exactly the affordance this package exists to remove.
 */

export type MemoryDeleteOptions = {
  readonly all: boolean;
  readonly json: boolean;
};

export type MemoryImportOptions = {
  readonly file: string;
  readonly json: boolean;
};

const LIST_HINT = "try `trylo memory list [--json]`";
const IMPORT_HINT = "try `trylo memory import --file <path> [--json]`";
const DELETE_HINT = "try `trylo memory delete --all --yes [--json]`";

export function parseMemory(argv: ReadonlyArray<string>): ParsedCommand {
  const sub = argv[0];
  if (sub === "--help" || sub === "-h") return familyHelpCommand("memory");

  if (sub === undefined) return usageError("memory requires a subcommand", "try `trylo memory list|import`");

  if (sub === "list" || sub === "compact") return parseList(argv.slice(1), sub);

  if (sub === "import") return parseImport(argv.slice(1));

  if (sub === "delete") return parseDelete(argv.slice(1));

  if (sub === "update" || sub === "retract") {
    if (argv.slice(1).some((token) => token !== "--json")) return usageError("memory update/retract reads one JSON request from stdin", "try `trylo memory update|retract --json`");
    return { kind: "memory_mutate", action: sub === "update" ? "correct" : "retract" };
  }

  return usageError(`unknown memory subcommand: ${sub}`, "try `trylo memory list|import|delete`");
}

function parseList(argv: ReadonlyArray<string>, action: "list" | "compact"): ParsedCommand {
  let json = false;

  for (const token of argv) {
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") return familyHelpCommand("memory");
    const flag = flagToken(token);
    const hint = action === "list" ? LIST_HINT : "try `trylo memory compact [--json]`";
    if (flag !== undefined) return usageError(`memory ${action} does not accept --${flag.name}`, hint);
    return usageError(`memory ${action} does not accept ${token}`, hint);
  }

  return { kind: action === "list" ? "memory_list" : "memory_compact", options: { json } };
}

function parseImport(argv: ReadonlyArray<string>): ParsedCommand {
  let file: string | undefined, json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) break;

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "--help" || token === "-h") return familyHelpCommand("memory");

    if (token === "--file") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return usageError("memory import --file needs a path", IMPORT_HINT);
      }
      file = value;
      index += 1;
      continue;
    }

    if (token.startsWith("--file=")) {
      file = token.slice("--file=".length);
      if (file.length === 0) return usageError("memory import --file needs a path", IMPORT_HINT);
      continue;
    }

    const flag = flagToken(token);
    if (flag !== undefined) return usageError(`memory import does not accept --${flag.name}`, IMPORT_HINT);

    return usageError(`memory import does not accept ${token}`, IMPORT_HINT);
  }

  if (file === undefined) return usageError("memory import requires --file <path>", IMPORT_HINT);

  return { kind: "memory_import", options: { file, json } };
}

/**
 * `memory delete --all --yes`：删除本机的全部用户学习数据（B20）。
 *
 * 两个旗标都必须显式给出。`--all` 说明范围，`--yes` 说明这不是演练——少一个就
 * 拒绝，而不是"默认小心一点"。删除不可恢复，所以没有 `--force` 这种一个词就能
 * 跳过确认的写法。
 */
function parseDelete(argv: ReadonlyArray<string>): ParsedCommand {
  let all = false, yes = false, json = false;

  for (const token of argv) {
    if (token === "--all") {
      all = true;
      continue;
    }

    if (token === "--yes") {
      yes = true;
      continue;
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "--help" || token === "-h") return familyHelpCommand("memory");

    const flag = flagToken(token);
    if (flag !== undefined) return usageError(`memory delete does not accept --${flag.name}`, DELETE_HINT);

    return usageError(`memory delete does not accept ${token}`, DELETE_HINT);
  }

  if (!all) return usageError("memory delete needs --all (this deletes every saved user memory)", DELETE_HINT);

  if (!yes) return usageError("memory delete needs --yes (there is no undo)", DELETE_HINT);

  return { kind: "memory_delete", options: { all, json } };
}

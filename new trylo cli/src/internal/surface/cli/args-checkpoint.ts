import { flagToken, readValue, usageError } from "./args-tokens.js";
import type { ParsedCommand } from "./args-primitives.js";
import { familyHelpCommand } from "./usage.js";

/**
 * `checkpoint` argument parsing.
 *
 * Two subcommands and nothing else, because undo is deliberately half a
 * feature: snapshots are taken *for* the person by the run, but spending one is
 * an act only the person performs. There is no `auto`, no `undo-last` and no
 * `prune` — a command that made rollback automatic would quietly turn the
 * workspace into something the model can rewind without asking.
 */

export type CheckpointListOptions = {
  readonly json: boolean;
};

export type CheckpointRestoreOptions = {
  readonly checkpointId: string;
  /**
   * Scoped rewind (WP11/F3): only these workspace-relative paths are
   * restored or removed; everything else stays byte-identical. Absent means
   * the legacy full-workspace restore, which also removes files created
   * after the snapshot.
   */
  readonly only?: ReadonlyArray<string>;
  readonly json: boolean;
};

/** `checkpoint diff <id>`: what restoring would change, without changing it. */
export type CheckpointDiffOptions = {
  readonly checkpointId: string;
  readonly json: boolean;
};

const LIST_HINT = "try `trylo checkpoint list [--json]`";
const RESTORE_HINT = "try `trylo checkpoint restore <id> [--only <path> ...] [--json]`";
const DIFF_HINT = "try `trylo checkpoint diff <id> [--json]`";

export function parseCheckpoint(argv: ReadonlyArray<string>): ParsedCommand {
  const sub = argv[0];
  if (sub === "--help" || sub === "-h") {
    return familyHelpCommand("checkpoint");
  }

  if (sub === undefined) {
    return usageError("checkpoint requires a subcommand", LIST_HINT);
  }

  if (sub === "list") {
    return parseCheckpointList(argv.slice(1));
  }

  if (sub === "restore") {
    return parseCheckpointRestore(argv.slice(1));
  }

  if (sub === "diff") {
    return parseCheckpointDiff(argv.slice(1));
  }

  return usageError(
    `unknown checkpoint subcommand: ${sub}`,
    "try `trylo checkpoint list|restore|diff`",
  );
}

function parseCheckpointList(argv: ReadonlyArray<string>): ParsedCommand {
  let json = false;

  for (const token of argv) {
    if (token === "--help" || token === "-h") {
      return familyHelpCommand("checkpoint");
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    return usageError(`checkpoint list does not accept ${token}`, LIST_HINT);
  }

  return { kind: "checkpoint_list", options: { json } };
}

/**
 * `restore <id> [--only <path> ...] [--json]`.
 *
 * The id is required and is not a prefix: a partial match that happened to be
 * unique today would restore a different checkpoint tomorrow, and undo is the
 * one command where "probably that one" is not good enough. `--only` scopes
 * the rewind to named workspace-relative paths (repeatable); without it the
 * whole workspace is restored, including removing files created later.
 */
function parseCheckpointRestore(argv: ReadonlyArray<string>): ParsedCommand {
  const id = argv[0];
  if (id === "--help" || id === "-h") {
    return familyHelpCommand("checkpoint");
  }

  if (id === undefined || id.startsWith("--")) {
    return usageError("checkpoint restore requires a checkpoint id", RESTORE_HINT);
  }

  let json = false;
  const only: string[] = [];
  let index = 1;

  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--json") {
      json = true;
      index += 1;
      continue;
    }

    const flag = flagToken(token);
    if (flag === undefined || flag.name !== "only") {
      return usageError(`checkpoint restore does not accept ${token}`, RESTORE_HINT);
    }

    const read = readValue(argv, index, flag.inlineValue);
    if (read.error !== undefined || (read.value ?? "").trim().length === 0) {
      return usageError(`option --only ${read.error ?? "requires a non-empty value"}`, RESTORE_HINT);
    }

    only.push(read.value ?? "");
    index = read.next;
  }

  return {
    kind: "checkpoint_restore",
    options: { checkpointId: id, ...(only.length === 0 ? {} : { only }), json },
  };
}

/**
 * `diff <id> [--json]`.
 *
 * Read-only by construction: it reports what `restore <id>` would change —
 * added, removed and modified paths against the manifest digest — and leaves
 * the workspace and the journal alone.
 */
function parseCheckpointDiff(argv: ReadonlyArray<string>): ParsedCommand {
  const id = argv[0];
  if (id === "--help" || id === "-h") {
    return familyHelpCommand("checkpoint");
  }

  if (id === undefined || id.startsWith("--")) {
    return usageError("checkpoint diff requires a checkpoint id", DIFF_HINT);
  }

  let json = false;

  for (const token of argv.slice(1)) {
    if (token === "--json") {
      json = true;
      continue;
    }
    return usageError(`checkpoint diff does not accept ${token}`, DIFF_HINT);
  }

  return { kind: "checkpoint_diff", options: { checkpointId: id, json } };
}

import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { checkpointWiring } from "./checkpoint-wiring.js";
import { applyScopedPlan, planScopedRestore } from "../../adapters/checkpoint/scope-restore.js";
import type { CheckpointListOptions, CheckpointRestoreOptions } from "./args-checkpoint.js";
import type { CliContext } from "./context.js";
import { aligned, humanBytes, limited, LIST_LIMIT, relativeTime } from "./humanize.js";
import { reportFailure } from "./run-failure.js";
import { tryloHome } from "./session-paths.js";
import { manifestRows, readCurrentRows, readManifest, scopedPlanIo } from "./checkpoint-workspace.js";

/**
 * `trylo checkpoint` handlers (WP E 波 §6.2).
 *
 * The run takes a snapshot; a person spends it. That asymmetry is the whole
 * design, and it is why this file has `list` and `restore` and nothing else:
 * an automatic rollback would let the model rewind the workspace as casually as
 * it edits it, and "undo the last thing" is a decision about *intent* that only
 * the person who asked for the change can make.
 *
 * Two things are never guessed:
 *
 *  - **which tree.** `workspaceRoot` is the current directory, the same root the
 *    sandbox bounds and the same root the run snapshots. Restoring into a tree
 *    that was never snapshotted is refused by the store, not assumed here;
 *  - **which id.** `restore` takes a whole id. A unique prefix today is two
 *    checkpoints tomorrow.
 *
 * A store failure is a `CONFIG` exit — the same class as an unreadable config
 * file — except for the two transient storage codes, which are `TEMPORARY`
 * because an outer caller may legitimately try again.
 */

type CheckpointHandlerContext = CliContext;

const STORAGE_DIR = "checkpoints";

function wiringOf(ctx: CheckpointHandlerContext) {
  return checkpointWiring({
    workspaceRoot: ctx.cwd,
    storageRoot: `${tryloHome(ctx.homeDir, ctx.env)}/${STORAGE_DIR}`,
    nowMs: ctx.now(),
  });
}

const TRANSIENT: ReadonlySet<string> = new Set(["storage_unavailable", "snapshot_interrupted", "restore_interrupted"]);

function exitCodeFor(code: string): ExitCode {
  return TRANSIENT.has(code) ? EXIT_CODES.TEMPORARY : EXIT_CODES.CONFIG;
}

function refuse(
  ctx: CheckpointHandlerContext,
  code: string,
  detail: string,
  hint: string,
): ExitCode {
  return reportFailure(ctx, { exitCode: exitCodeFor(code), message: detail, hint });
}

export async function handleCheckpointList(
  ctx: CheckpointHandlerContext,
  options: CheckpointListOptions,
): Promise<ExitCode> {
  const listed = await wiringOf(ctx).port.list();
  if (!listed.ok) {
    return refuse(ctx, listed.code, listed.detail, "checkpoint storage could not be read");
  }

  if (options.json) {
    ctx.stdout(`${JSON.stringify(listed.value, null, 2)}\n`);
    return EXIT_CODES.OK;
  }

  if (listed.value.length === 0) {
    // Say what a checkpoint is for, not just that there are none: the command
    // is how a person discovers the snapshots exist at all.
    ctx.stdout("no checkpoints yet\n");
    ctx.stdout("one is taken automatically before a write, so there will be one after the next edit\n");
    return EXIT_CODES.OK;
  }

  const { shown, hidden } = limited(listed.value, LIST_LIMIT);
  const now = ctx.now();
  const lines = aligned(
    shown.map((entry) => [
      entry.checkpointId,
      entry.label,
      `${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"}`,
      humanBytes(entry.totalBytes),
      relativeTime(Date.parse(entry.createdAt), now),
    ]),
  );

  ctx.stdout(`${lines.join("\n")}\n`);

  if (hidden > 0) {
    ctx.stdout(`... ${hidden} older (--json lists them all)\n`);
  }

  return EXIT_CODES.OK;
}

export async function handleCheckpointRestore(
  ctx: CheckpointHandlerContext,
  options: CheckpointRestoreOptions,
): Promise<ExitCode> {
  if (options.only !== undefined && options.only.length > 0) {
    return handleScopedRestore(ctx, options.checkpointId, options.only, options.json);
  }

  const restored = await wiringOf(ctx).port.restore({ checkpointId: options.checkpointId });
  if (!restored.ok) {
    return refuse(
      ctx,
      restored.code,
      restored.detail,
      "`trylo checkpoint list` shows the ids this workspace can restore",
    );
  }

  const summary = {
    checkpointId: options.checkpointId,
    restoredFiles: restored.value.restoredFiles,
    removedFiles: restored.value.removedFiles,
  };

  ctx.stdout(
    options.json
      ? `${JSON.stringify(summary, null, 2)}\n`
      : `restored ${options.checkpointId}: ${restored.value.restoredFiles} file(s) restored, ${restored.value.removedFiles} removed\n`,
  );

  if (!options.json && restored.value.removedFiles > 0) {
    // The full restore removes files created after the snapshot (crash
    // recovery depends on exactly that). Say so where the person sees it:
    // a scoped `--only` rewind never deletes outside its scope.
    ctx.stderr(
      `warning: restore removed ${restored.value.removedFiles} file(s) created after the snapshot; ` +
      "`trylo checkpoint diff <id>` previews this, `restore <id> --only <paths>` rewinds selected files\n",
    );
  }

  return EXIT_CODES.OK;
}

/**
 * Scoped rewind (WP11/F3): only the named paths are restored or removed.
 * Files created after the snapshot that are *not* named stay untouched —
 * the property the full restore deliberately does not have.
 */
async function handleScopedRestore(
  ctx: CheckpointHandlerContext,
  checkpointId: string,
  scope: ReadonlyArray<string>,
  json: boolean,
): Promise<ExitCode> {
  const storageRoot = `${tryloHome(ctx.homeDir, ctx.env)}/${STORAGE_DIR}`;
  const manifest = readManifest(storageRoot, checkpointId);
  if (!manifest.ok) {
    return refuse(
      ctx,
      manifest.code,
      manifest.detail,
      "`trylo checkpoint list` shows the ids this workspace can restore",
    );
  }

  const current = readCurrentRows(ctx.cwd, manifest.manifest.ignores);
  if (!current.ok) {
    return refuse(ctx, current.code, current.detail, "fix workspace access, then restore again");
  }

  const planned = planScopedRestore({ snapshot: manifestRows(manifest.manifest), current: current.rows, scope });
  if (!planned.ok) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.USAGE,
      message: planned.detail,
      hint: "`trylo checkpoint diff <id>` shows the paths a restore would touch",
    });
  }

  const applied = await applyScopedPlan(planned.plan, scopedPlanIo(storageRoot, checkpointId, ctx.cwd));
  if (!applied.ok) {
    return refuse(ctx, applied.code, applied.detail, "restoring again converges: completed files stay restored");
  }

  const summary = {
    checkpointId,
    scope: [...scope].sort(),
    restoredFiles: applied.value.restoredFiles,
    removedFiles: applied.value.removedFiles,
    alreadyCurrent: planned.plan.alreadyCurrent,
    keptOutsideScope: planned.plan.keptOutsideScope,
  };

  ctx.stdout(
    json
      ? `${JSON.stringify(summary, null, 2)}\n`
      : `restored ${checkpointId} (scoped to ${scope.length} path(s)): ` +
      `${applied.value.restoredFiles} file(s) restored, ${applied.value.removedFiles} removed, ` +
      `${planned.plan.alreadyCurrent.length} already current, ${planned.plan.keptOutsideScope.length} kept outside scope\n`,
  );

  return EXIT_CODES.OK;
}

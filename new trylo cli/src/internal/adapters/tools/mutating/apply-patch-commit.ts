import { mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { SandboxPolicy, ToolOutcome } from "../../../ports/tools.js";
import { writeFileAtomicallySync, readFileUtf8, type WriteQueue } from "./atomic-write.js";
import type { ApplyPatchHunk } from "./apply-patch-format.js";
import { applyUpdateChunks, prepareSource, type AppliedRegion } from "./apply-patch-match.js";
import { renderPreview } from "./apply-patch-preview.js";

/**
 * One hunk's filesystem commit, and nothing else.
 *
 * Every commit is read-compare-write under queue exclusivity: the match was
 * computed against bytes read moments ago, and another writer landing in
 * between must fail the commit rather than silently win or lose. Atomic
 * renames mean a committed file is always whole; a hunk that fails after
 * earlier hunks committed reports the partial delta instead of rolling back
 * (there is no cross-file transaction to roll back to — the turn's
 * checkpoint snapshot is the way back).
 */

export type ApplyPatchConfig = {
  readonly writeQueue: WriteQueue;
  readonly policy: SandboxPolicy;
};

export type AppliedFileChange =
  | { readonly op: "added"; readonly path: string; readonly bytes: number; readonly mode: "created" | "overwritten"; readonly preview: string }
  | { readonly op: "deleted"; readonly path: string; readonly bytes: number; readonly preview: string }
  | { readonly op: "updated"; readonly path: string; readonly bytes: number; readonly preview: string }
  | {
    readonly op: "moved";
    readonly from: string;
    readonly path: string;
    readonly bytes: number;
    readonly preview: string;
    /**
     * True when the destination already existed (WP11/F4: the turn-diff
     * rename pairing must refuse these, mirroring Codex
     * `baseline.contains(dest)`). Absent means unknown-or-false; only an
     * explicit true suppresses pairing.
     */
    readonly overwrote?: boolean;
  };

export type AddTarget = {
  readonly kind: "add";
  readonly hunk: Extract<ApplyPatchHunk, { readonly kind: "add" }>;
  readonly absolutePath: string;
};

export type DeleteTarget = {
  readonly kind: "delete";
  readonly hunk: Extract<ApplyPatchHunk, { readonly kind: "delete" }>;
  readonly absolutePath: string;
};

export type UpdateTarget = {
  readonly kind: "update";
  readonly hunk: Extract<ApplyPatchHunk, { readonly kind: "update" }>;
  readonly absolutePath: string;
  readonly moveAbsolute: string | undefined;
};

export type ApplyPatchTarget = AddTarget | DeleteTarget | UpdateTarget;

export type AppliedAccumulator = {
  readonly changes: AppliedFileChange[];
  exact: boolean;
};

export type CommitContext = {
  readonly config: ApplyPatchConfig;
  readonly accumulator: AppliedAccumulator;
  readonly targets: ReadonlyArray<ApplyPatchTarget>;
  readonly atIndex: number;
  readonly signal: AbortSignal;
};

function fail(code: string, message: string): ToolOutcome {
  return { outcome: "error", code, message };
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

type OptionalContent =
  | { readonly found: true; readonly content: string }
  | { readonly found: false }
  | { readonly failed: string };

function readOptional(absolutePath: string): OptionalContent {
  try {
    return { found: true, content: readFileUtf8(absolutePath) };
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") {
      return { found: false };
    }
    const detail = error instanceof Error ? error.message : "read_error";
    return { failed: `read_failed:${detail}` };
  }
}

function isDirectory(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    // Missing or unreadable here is answered by the read that follows.
    return false;
  }
}

export function summarizeLines(applied: ReadonlyArray<AppliedFileChange>): string[] {
  return applied.map((entry) => {
    if (entry.op === "added") {
      return `A ${entry.path}`;
    }
    if (entry.op === "deleted") {
      return `D ${entry.path}`;
    }
    if (entry.op === "moved") {
      return `R ${entry.from} -> ${entry.path}`;
    }
    return `M ${entry.path}`;
  });
}

function summarize(applied: ReadonlyArray<AppliedFileChange>): string {
  return summarizeLines(applied).join(", ");
}

function pendingPaths(targets: ReadonlyArray<ApplyPatchTarget>, fromIndex: number): string {
  return targets
    .slice(fromIndex)
    .map((target) => (target.kind === "update" && target.hunk.moveTo !== undefined ? `${target.hunk.path} -> ${target.hunk.moveTo}` : target.hunk.path))
    .join(", ");
}

export function partialFailure(
  code: string,
  reason: string,
  atDisplay: string,
  context: CommitContext,
): ToolOutcome {
  const applied = summarize(context.accumulator.changes);
  return fail(
    code,
    `${code}: ${reason} at ${atDisplay}. Applied before failure${applied.length === 0 ? ": none" : `: ${applied}`}. Not applied: ${pendingPaths(context.targets, context.atIndex)}. Earlier files remain applied; no rollback was performed.`,
  );
}

/**
 * Cancelling after side effects landed is a partial failure record, not a
 * silent drop. `cancelled` keeps one meaning for this tool — "this call
 * landed nothing" — so any abort with a non-empty delta becomes
 * `apply_cancelled` with the same applied/pending shape as every other
 * partial failure. Journal facts only emit on success (loop contract), which
 * is exactly why the human-readable delta must survive here: it is the only
 * record of the landed files on this path.
 */
export function abortOutcome(context: CommitContext): ToolOutcome {
  if (context.accumulator.changes.length === 0) {
    return { outcome: "cancelled" };
  }
  const applied = summarize(context.accumulator.changes);
  return fail(
    "apply_cancelled",
    `apply_cancelled: user cancel stopped the patch after ${context.accumulator.changes.length} file(s). Applied: ${applied}. Not applied: ${pendingPaths(context.targets, context.atIndex)}. Earlier files remain applied; no rollback was performed.`,
  );
}

function oversizedFailure(config: ApplyPatchConfig, content: string, display: string, context: CommitContext): ToolOutcome | undefined {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= config.policy.maxWriteBytes) {
    return undefined;
  }
  const applied = summarize(context.accumulator.changes);
  return fail(
    "write_too_large",
    `write_too_large: apply_patch refuses ${display} at ${bytes} bytes above the ${config.policy.maxWriteBytes} byte ceiling; it is never silently truncated. Applied before failure${applied.length === 0 ? ": none" : `: ${applied}`}. Not applied: ${pendingPaths(context.targets, context.atIndex)}.`,
  );
}

async function commitText(
  config: ApplyPatchConfig,
  absolutePath: string,
  expected: string | undefined,
  content: string,
  signal: AbortSignal,
): Promise<{ readonly committed: true; readonly bytes: number; readonly created: boolean } | { readonly committed: false }> {
  return config.writeQueue.exclusive(absolutePath, async () => {
    signal.throwIfAborted();
    const current = readOptional(absolutePath);
    if ("failed" in current) {
      throw new Error(current.failed);
    }
    if ((current.found ? current.content : undefined) !== expected) {
      return { committed: false as const };
    }
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    const written = writeFileAtomicallySync(absolutePath, content);
    return { committed: true as const, bytes: written.bytes, created: written.mode === "created" };
  });
}

function changedFailure(display: string, context: CommitContext): ToolOutcome {
  return partialFailure(
    "file_changed_since_read",
    "another writer changed the file before this commit",
    display,
    context,
  );
}

function writeFailedFailure(detail: string, display: string, context: CommitContext): ToolOutcome {
  return partialFailure("write_failed", `write_failed:${detail}`, display, context);
}

export async function commitAdd(context: CommitContext, target: AddTarget, display: string): Promise<ToolOutcome | undefined> {
  if (isDirectory(target.absolutePath)) {
    return partialFailure("path_is_directory", "target is a directory", display, context);
  }
  const known = readOptional(target.absolutePath);
  if ("failed" in known) {
    return partialFailure("read_failed", known.failed, display, context);
  }
  const tooLarge = oversizedFailure(context.config, target.hunk.contents, display, context);
  if (tooLarge !== undefined) {
    return tooLarge;
  }
  let committed;
  try {
    committed = await commitText(context.config, target.absolutePath, known.found ? known.content : undefined, target.hunk.contents, context.signal);
  } catch (error) {
    if (context.signal.aborted) {
      return abortOutcome(context);
    }
    return writeFailedFailure(error instanceof Error ? error.message : "write_error", display, context);
  }
  if (!committed.committed) {
    return changedFailure(display, context);
  }
  context.accumulator.changes.push({
    op: "added",
    path: display,
    bytes: committed.bytes,
    mode: committed.created ? "created" : "overwritten",
    preview: renderPreview({ kind: "added", path: display, before: "", after: target.hunk.contents, regions: [] }),
  });
  if (context.signal.aborted) {
    return abortOutcome(context);
  }
  return undefined;
}

export async function commitDelete(context: CommitContext, target: DeleteTarget, display: string): Promise<ToolOutcome | undefined> {
  const known = readOptional(target.absolutePath);
  if ("failed" in known) {
    return partialFailure("read_failed", known.failed, display, context);
  }
  if (!known.found) {
    return partialFailure("file_missing", "delete target does not exist", display, context);
  }
  if (isDirectory(target.absolutePath)) {
    return partialFailure("path_is_directory", "delete target is a directory", display, context);
  }
  try {
    await context.config.writeQueue.exclusive(target.absolutePath, async () => {
      context.signal.throwIfAborted();
      const current = readOptional(target.absolutePath);
      if ("failed" in current) {
        throw new Error(current.failed);
      }
      if (!current.found || current.content !== known.content) {
        throw new Error("changed");
      }
      rmSync(target.absolutePath);
    });
  } catch (error) {
    if (context.signal.aborted) {
      return abortOutcome(context);
    }
    if (error instanceof Error && error.message === "changed") {
      return changedFailure(display, context);
    }
    const stillThere = readOptional(target.absolutePath);
    if (!(!("failed" in stillThere) && !stillThere.found)) {
      context.accumulator.exact = false;
    }
    return partialFailure("remove_failed", `remove_failed:${error instanceof Error ? error.message : "remove_error"}`, display, context);
  }
  context.accumulator.changes.push({
    op: "deleted",
    path: display,
    bytes: 0,
    preview: renderPreview({ kind: "deleted", path: display, before: known.content, after: "", regions: [] }),
  });
  if (context.signal.aborted) {
    return abortOutcome(context);
  }
  return undefined;
}

export async function commitUpdate(context: CommitContext, target: UpdateTarget, display: string): Promise<ToolOutcome | undefined> {
  const known = readOptional(target.absolutePath);
  if ("failed" in known) {
    return partialFailure("read_failed", known.failed, display, context);
  }
  if (!known.found) {
    return partialFailure("file_missing", "update target does not exist", display, context);
  }
  if (isDirectory(target.absolutePath)) {
    return partialFailure("path_is_directory", "update target is a directory", display, context);
  }
  const applied = applyUpdateChunks(prepareSource(known.content), target.hunk.chunks, display);
  if (!applied.ok) {
    return partialFailure(applied.code, applied.message, display, context);
  }
  const tooLarge = oversizedFailure(context.config, applied.content, display, context);
  if (tooLarge !== undefined) {
    return tooLarge;
  }
  if (target.moveAbsolute === undefined) {
    let committed;
    try {
      committed = await commitText(context.config, target.absolutePath, known.content, applied.content, context.signal);
    } catch (error) {
      if (context.signal.aborted) {
        return abortOutcome(context);
      }
      return writeFailedFailure(error instanceof Error ? error.message : "write_error", display, context);
    }
    if (!committed.committed) {
      return changedFailure(display, context);
    }
    context.accumulator.changes.push({
      op: "updated",
      path: display,
      bytes: committed.bytes,
      preview: renderPreview({ kind: "updated", path: display, before: known.content, after: applied.content, regions: applied.regions }),
    });
    if (context.signal.aborted) {
      return abortOutcome(context);
    }
    return undefined;
  }
  return commitMove(context, target, target.moveAbsolute, display, known.content, applied.content, applied.regions);
}

async function commitMove(
  context: CommitContext,
  target: UpdateTarget,
  moveAbsolute: string,
  display: string,
  sourceContent: string,
  newContent: string,
  regions: ReadonlyArray<AppliedRegion>,
): Promise<ToolOutcome | undefined> {
  const destination = target.hunk.moveTo ?? display;
  const tooLarge = oversizedFailure(context.config, newContent, destination, context);
  if (tooLarge !== undefined) {
    return tooLarge;
  }
  const knownDest = readOptional(moveAbsolute);
  if ("failed" in knownDest) {
    return partialFailure("read_failed", knownDest.failed, destination, context);
  }
  let committed;
  try {
    committed = await commitText(context.config, moveAbsolute, knownDest.found ? knownDest.content : undefined, newContent, context.signal);
  } catch (error) {
    if (context.signal.aborted) {
      return abortOutcome(context);
    }
    return writeFailedFailure(error instanceof Error ? error.message : "write_error", destination, context);
  }
  if (!committed.committed) {
    return partialFailure(
      "file_changed_since_read",
      "another writer changed the destination before this commit",
      destination,
      context,
    );
  }
  const landed: AppliedFileChange = {
    op: "added",
    path: destination,
    bytes: committed.bytes,
    mode: committed.created ? "created" : "overwritten",
    preview: renderPreview({ kind: "moved", path: destination, from: display, before: sourceContent, after: newContent, regions }),
  };
  if (context.signal.aborted) {
    // The destination already landed: record it before reporting the stop.
    context.accumulator.changes.push(landed);
    return abortOutcome(context);
  }
  try {
    await context.config.writeQueue.exclusive(target.absolutePath, async () => {
      context.signal.throwIfAborted();
      const current = readOptional(target.absolutePath);
      if ("failed" in current) {
        throw new Error(current.failed);
      }
      if (!current.found || current.content !== sourceContent) {
        throw new Error("changed");
      }
      rmSync(target.absolutePath);
    });
  } catch (error) {
    // The destination already holds the new content: the delta records that
    // write first, exactly like Codex keeps the committed destination delta
    // on a failed move. Exactness depends on whether the source is intact.
    context.accumulator.changes.push(landed);
    if (context.signal.aborted) {
      return abortOutcome(context);
    }
    const stillThere = readOptional(target.absolutePath);
    const intact = !("failed" in stillThere) && stillThere.found && stillThere.content === sourceContent;
    if (!intact) {
      context.accumulator.exact = false;
    }
    if (error instanceof Error && error.message === "changed") {
      return partialFailure(
        "file_changed_since_read",
        `the move destination was written but the source changed underneath; destination '${destination}' holds the new content while the source was left alone`,
        display,
        context,
      );
    }
    return partialFailure(
      "remove_failed",
      `remove_failed:${error instanceof Error ? error.message : "remove_error"} after the destination was written; destination '${destination}' holds the new content${intact ? " and the source is intact" : " but the source state is uncertain"}`,
      display,
      context,
    );
  }
  context.accumulator.changes.push({
    op: "moved",
    from: display,
    path: destination,
    bytes: committed.bytes,
    preview: renderPreview({ kind: "moved", path: destination, from: display, before: sourceContent, after: newContent, regions }),
    ...(knownDest.found ? { overwrote: true } : {}),
  });
  if (context.signal.aborted) {
    return abortOutcome(context);
  }
  return undefined;
}

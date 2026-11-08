import type { JsonObject } from "../protocol/envelope.js";
import type { TurnDiffOp, TurnDiffTracker } from "./turn-diff.js";

/**
 * Feeding successful mutating-tool outcomes into the turn tracker (WP11/C20).
 *
 * Split out of `turn-diff.ts` for the file-size discipline; the seam is the
 * outcome value, not the tool name. Shape-dispatched, not name-dispatched:
 * `applied[]` + `exact` is the multi-file patch shape, `fileWrite` +
 * path/mode the single-file shape. Anything else (reads, shells, unknown
 * tools) is ignored — only a claimed file mutation that cannot be understood
 * invalidates, never a tool the tracker was not built for.
 */

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const APPLY_PATCH_OPS = new Set(["added", "deleted", "updated", "moved"]);
const SINGLE_WRITE_MODES = new Set(["created", "overwritten", "patched"]);

export function feedTurnDiffFromOutcome(
  tracker: TurnDiffTracker,
  value: JsonObject,
): void {
  const batch = value["applied"];
  if (Array.isArray(batch)) {
    feedPatchBatch(tracker, value, batch);
    return;
  }

  const single = value["fileWrite"];
  if (isRecord(single)) {
    feedSingleWrite(tracker, value, single);
  }
}

function feedPatchBatch(tracker: TurnDiffTracker, value: JsonObject, batch: ReadonlyArray<unknown>): void {
  if (value["exact"] !== true) {
    tracker.invalidate("inexact apply_patch delta");
    return;
  }
  for (const raw of batch) {
    if (!isRecord(raw)) {
      tracker.invalidate("an apply_patch change is not an object");
      return;
    }

    const op = textOf(raw["op"]);
    const path = textOf(raw["path"]);
    const preview = raw["preview"];

    if (op === undefined || !APPLY_PATCH_OPS.has(op) || path === undefined || path.length === 0) {
      tracker.invalidate("an apply_patch change names no valid op/path");
      return;
    }

    if (preview !== undefined && typeof preview !== "string") {
      tracker.invalidate(`an apply_patch change carries a non-text preview for ${path}`);
      return;
    }

    if (op === "moved") {
      const from = textOf(raw["from"]);
      if (from === undefined || from.length === 0) {
        tracker.invalidate(`a move arrived without a source for ${path}`);
        return;
      }

      const overwrote = raw["overwrote"];
      const originPreview = raw["originPreview"];

      if (overwrote !== undefined && typeof overwrote !== "boolean") {
        tracker.invalidate(`a move carries a non-boolean overwrote for ${path}`);
        return;
      }

      if (originPreview !== undefined && typeof originPreview !== "string") {
        tracker.invalidate(`a move carries a non-text origin preview for ${path}`);
        return;
      }

      tracker.track({
        path,
        op: "moved",
        from,
        exact: true,
        ...(preview === undefined ? {} : { preview }),
        ...(overwrote === undefined ? {} : { overwrote }),
        ...(originPreview === undefined ? {} : { originPreview }),
      });
      continue;
    }

    const mode = textOf(raw["mode"]);

    tracker.track({
      path,
      op: op as TurnDiffOp,
      exact: true,
      ...(preview === undefined ? {} : { preview }),
      ...(op === "added" && mode === "created" ? { isNew: true } : {}),
    });
  }
}

function feedSingleWrite(tracker: TurnDiffTracker, value: JsonObject, effect: Record<string, unknown>): void {
  const path = textOf(effect["path"]);
  const mode = textOf(effect["mode"]);
  if (path === undefined || path.length === 0 || mode === undefined || !SINGLE_WRITE_MODES.has(mode)) {
    return;
  }

  const preview = value["preview"];
  if (preview !== undefined && typeof preview !== "string") {
    tracker.invalidate(`a file write carries a non-text preview for ${path}`);
    return;
  }

  tracker.track({
    path,
    op: "added",
    exact: true,
    ...(preview === undefined ? {} : { preview }),
    ...(mode === "created" ? { isNew: true } : {}),
  });
}

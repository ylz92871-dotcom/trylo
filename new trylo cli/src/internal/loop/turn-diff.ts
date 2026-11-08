/**
 * The net unified diff for one turn, from committed file mutations.
 *
 * Shape-port of Codex `core/src/turn_diff_tracker.rs` (`TurnDiffTracker`):
 * baseline/current maps per path, an origin map for renames, rename pairing,
 * and whole-turn invalidation when a delta is not exact. What is deliberately
 * not ported is the re-render: Codex keeps full before/after contents and
 * renders with `similar`; here the committed preview strings *are* what
 * landed (see `apply-patch-preview.ts`: rendering from ops, never re-diffing),
 * so the net diff aggregates previews instead of re-rendering contents.
 *
 * Two honest deltas from Codex, both recorded rather than hidden:
 *
 * - First-touch before-content is not retained, so a file the turn creates
 *   and a file it rewrites can render alike as additions. Rename pairing
 *   still applies the structural guards (see `pairOrigin`), but content
 *   equality beyond the previews is out of reach.
 * - Display bounding (the 64k cap here, the 120-line cap in previews) is
 *   *not* inexactness: Codex invalidates on incomplete *deltas*, not on
 *   shortened *renderings*. A truncated rendering carries its marker.
 *
 * One turn, one tracker: the loop creates it in `assembleEngine`, feeds
 * every committed mutating-tool outcome through `noteTurnDiff`, and
 * publishes the net diff on the turn result. It never touches the workspace
 * — rereading the tree would race the next write — and it never touches the
 * journal. Like Codex, it is a live-turn artifact: a restarted session keeps
 * the durable `file_write` facts but not the previews, so a net diff cannot
 * be rebuilt after the fact without a journal shape change (see the WP11
 * construction record for the deferred migration).
 */

import { countPreview, renderDeletion, renderEntry } from "./turn-diff-render.js";

export type TurnDiffOp = "added" | "deleted" | "updated" | "moved";

export type TurnDiffChange = {
  /** Workspace-relative, POSIX separators — the same key the journal uses. */
  readonly path: string;
  readonly op: TurnDiffOp;
  /** Set for `moved`: where the bytes came from. */
  readonly from?: string;
  /**
   * The unified-diff preview the commit rendered from the ops that landed.
   * Absent when the producer retained no renderable content (single-file
   * overwrite without a before image): the file still counts in the summary
   * and is listed in the trailer, never invented.
   */
  readonly preview?: string;
  /**
   * False when the delta is partial, truncated, or otherwise inexact.
   * One inexact change invalidates the whole turn (Codex: `!delta.is_exact()`),
   * because a net diff built on a partial delta would read as complete.
   */
  readonly exact: boolean;
  /**
   * True for `added` when the file did not exist before this turn's write
   * (`apply_patch` reports `created` vs `overwritten`). It is what lets an
   * add-then-delete collapse to net zero instead of rendering a deletion of
   * something the turn itself created.
   */
  readonly isNew?: boolean;
  /**
   * True for `moved` when the destination already existed. Pairing is then
   * refused (Codex: `baseline.contains(dest)` skips): the destination renders
   * as content change, the origin as deletion.
   */
  readonly overwrote?: boolean;
  /**
   * Delete-style preview for a moved-away origin, when the producer retained
   * one. Absent, the origin renders as a header-only deletion that points at
   * the turn checkpoint instead of fabricating content.
   */
  readonly originPreview?: string;
  /**
   * True when the bytes are not text. Rendered as a `Binary files … differ`
   * line, never as +/- rows. Producers set this; the tracker never sniffs.
   * (No current producer sets it: reserved, see the WP11 record F13.)
   */
  readonly binary?: boolean;
};

export type TurnDiffSummary = {
  /** Distinct paths with a surviving net change. */
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly binaryFiles: number;
  /** Paths hit more than once this turn; only the last preview is shown. */
  readonly collapsed: number;
  /** Changed files with no retained preview (listed in the trailer). */
  readonly unrendered: number;
};

export type TrackedChange = {
  readonly from: string | undefined;
  readonly preview: string | undefined;
  readonly binary: boolean;
  readonly writes: number;
};

export const MAX_DIFF_CHARS = 64_000;

/**
 * One turn's net diff. Create per turn, feed in commit order, read once.
 *
 * Rename pairing mirrors Codex `rename_pairs`, evaluated at render time so
 * later events in the same turn can still break the pairing:
 *
 * - `dest == origin` never pairs (recorded as no origin at track time);
 * - the origin reappearing under its old name (`current.has(origin)`)
 *   breaks the pairing: the destination renders as an addition, the origin
 *   as itself — never both a rename and an addition of the same name;
 * - an origin the turn itself created (`createdThisTurn`) never pairs: there
 *   is no earlier state to rename from;
 * - a destination that already existed (`overwrote`, or a tombstone proving
 *   prior existence) never pairs: the destination renders as content change,
 *   the origin as deletion.
 */
export type TurnDiffTracker = {
  track(change: TurnDiffChange): void;
  invalidate(reason: string): void;
  readonly valid: boolean;
  readonly invalidReason: string | undefined;
  unifiedDiff(): string | undefined;
  summary(): TurnDiffSummary;
};

export function createTurnDiffTracker(): TurnDiffTracker {
  let valid = true;
  let invalidReason: string | undefined;
  const origins = new Map<string, string>();
  const current = new Map<string, TrackedChange>();
  /**
   * Delete previews for files that existed before the turn and are gone now.
   * Without these, an update-then-delete would render nothing — a deletion
   * presented as no change.
   */
  const tombstones = new Map<string, TrackedChange>();
  /**
   * Paths created by this turn (`added` with `isNew`). Deleting one collapses
   * to net zero instead of a tombstone: the turn removed what it made.
   */
  const createdThisTurn = new Set<string>();

  function noteOrigin(path: string, from: string | undefined): string | undefined {
    if (from === undefined || from === path) {
      return undefined;
    }

    const earlier = origins.get(from) ?? from;

    origins.delete(from);
    origins.delete(path);

    if (earlier !== path) {
      origins.set(path, earlier);
    }

    return earlier;
  }

  function trackDelete(path: string, change: TurnDiffChange): void {
    current.delete(path);
    origins.delete(path);

    if (createdThisTurn.has(path)) {
      createdThisTurn.delete(path);
      return;
    }

    tombstones.set(path, {
      from: undefined,
      preview: change.preview,
      binary: change.binary === true,
      writes: (tombstones.get(path)?.writes ?? 0) + 1,
    });
  }

  function trackUpsert(path: string, change: TurnDiffChange, origin: string | undefined): void {
    tombstones.delete(path);
    const seen = current.get(path);

    if (change.op === "added" && change.isNew === true) {
      createdThisTurn.add(path);
    }

    current.set(path, {
      from: origin ?? seen?.from,
      preview: change.preview,
      binary: change.binary === true,
      writes: (seen?.writes ?? 0) + 1,
    });
  }

  function trackMoved(change: TurnDiffChange, from: string): void {
    const originWasNew = createdThisTurn.has(from);
    const origin = noteOrigin(change.path, from);
    const carried = current.get(from);

    current.delete(from);
    tombstones.delete(from);

    if (change.overwrote === true) {
      // Move onto an existing destination: no pairing, ever. The destination
      // keeps whatever created-status it already had; the origin only leaves
      // a tombstone when it predates the turn.
      origins.delete(change.path);

      if (originWasNew) {
        createdThisTurn.delete(from);
      }

      const { from: _origin, ...kept } = change;

      trackUpsert(change.path, { ...kept, op: "updated" }, undefined);
      const dest = current.get(change.path);
      if (dest !== undefined && carried !== undefined) {
        current.set(change.path, { ...dest, writes: dest.writes + carried.writes });
      }

      if (!originWasNew) {
        tombstones.set(from, {
          from: undefined,
          preview: change.originPreview,
          binary: false,
          writes: 1,
        });
      }

      return;
    }

    if (originWasNew) {
      // The destination's bytes are all-new, but the origin stays marked:
      // it was never in the baseline, so no pairing may claim it was.
      createdThisTurn.add(change.path);
    }

    trackUpsert(change.path, change, origin ?? carried?.from ?? from);
    const entry = current.get(change.path);
    if (entry !== undefined && carried !== undefined) {
      current.set(change.path, { ...entry, writes: entry.writes + carried.writes });
    }
  }

  const tracker: TurnDiffTracker = {
    track(change: TurnDiffChange): void {
      if (!valid) {
        return;
      }

      if (change.path.length === 0) {
        tracker.invalidate("a change arrived without a path");
        return;
      }

      if (!change.exact) {
        tracker.invalidate(`inexact delta for ${change.path}`);
        return;
      }

      if (change.op === "moved") {
        const from = change.from ?? "";
        if (from.length === 0) {
          tracker.invalidate(`a move arrived without a source for ${change.path}`);
          return;
        }

        trackMoved(change, from);

        return;
      }

      if (change.op === "deleted") {
        trackDelete(change.path, change);
        return;
      }

      // A later write to a rename destination keeps the origin: the net
      // change is still "moved from there", now with newer content.
      trackUpsert(change.path, change, undefined);
    },
    invalidate(reason: string): void {
      valid = false;
      invalidReason = reason;
      current.clear();
      origins.clear();
      tombstones.clear();
      createdThisTurn.clear();
    },
    get valid(): boolean {
      return valid;
    },
    get invalidReason(): string | undefined {
      return invalidReason;
    },
    unifiedDiff(): string | undefined {
      if (!valid || (current.size === 0 && tombstones.size === 0)) {
        return undefined;
      }

      const paths = [...current.keys(), ...tombstones.keys()].sort();
      const handled = new Set<string>();
      const parts: string[] = [];
      let unrendered = 0;

      for (const path of paths) {
        if (handled.has(path)) {
          continue;
        }

        handled.add(path);
        const tombstone = tombstones.get(path);
        if (tombstone !== undefined) {
          parts.push(renderDeletion(path, tombstone));
          continue;
        }

        const entry = current.get(path);
        if (entry === undefined) {
          continue;
        }

        if (entry.preview === undefined && !entry.binary) {
          unrendered += 1;
          continue;
        }

        const origin = pairOrigin(path, entry);

        parts.push(renderEntry(path, entry, origin));
      }

      if (unrendered > 0) {
        parts.push(
          `... [${unrendered} changed file(s) without retained previews are listed in the turn summary, not rendered here] ...\n`,
        );
      }

      if (parts.length === 0) {
        return undefined;
      }

      const joined = parts.join("");
      if (joined.length <= MAX_DIFF_CHARS) {
        return joined;
      }

      return `${joined.slice(0, MAX_DIFF_CHARS)}\n... [turn diff truncated: ${joined.length - MAX_DIFF_CHARS} more chars] ...\n`;
    },
    summary(): TurnDiffSummary {
      if (!valid) {
        return { files: 0, insertions: 0, deletions: 0, binaryFiles: 0, collapsed: 0, unrendered: 0 };
      }

      let insertions = 0;
      let deletions = 0;
      let binaryFiles = 0;
      let collapsed = 0;
      let unrendered = 0;
      const entries = [...current.values(), ...tombstones.values()];

      for (const entry of entries) {
        if (entry.binary) {
          binaryFiles += 1;
          continue;
        }

        if (entry.preview === undefined) {
          unrendered += 1;
          continue;
        }

        const counted = countPreview(entry.preview);

        insertions += counted.insertions;
        deletions += counted.deletions;

        if (entry.writes > 1) {
          collapsed += 1;
        }
      }

      return { files: current.size + tombstones.size, insertions, deletions, binaryFiles, collapsed, unrendered };
    },
  };

  /**
   * The render-time pairing decision. A recorded origin only pairs when the
   * turn's later events left it a genuine rename: the origin must be gone
   * from the live tree, must predate the turn, and the destination must not
   * have existed before.
   */
  function pairOrigin(path: string, entry: TrackedChange): string | undefined {
    const origin = entry.from ?? origins.get(path);
    if (origin === undefined) {
      return undefined;
    }

    if (current.has(origin)) {
      return undefined;
    }

    if (createdThisTurn.has(origin)) {
      return undefined;
    }

    if (tombstones.has(path)) {
      return undefined;
    }

    return origin;
  }

  return tracker;
}

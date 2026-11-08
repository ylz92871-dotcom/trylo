import path from "node:path";

/**
 * Managed-worktree path layout (WP25.2 / C79, L70).
 *
 * Source: Codex `codex-rs/worktree/src/paths.rs:26-29` (bucket allocation) and
 * `codex-rs/worktree/src/lib.rs:363-397` (layout recognition).
 *
 * A managed checkout sits exactly two levels below the pool root:
 *
 *   <root>/<bucket>/<repository name>
 *
 * `bucket` is four ASCII hex digits, taken from the head of a random
 * identifier. Two consequences are load-bearing and each is pinned by a test:
 *
 *  - **Allocation cannot collide by construction.** A bucket is claimed with a
 *    create-that-must-not-already-exist, so two sessions racing never share a
 *    directory, and no registry has to be locked or read first.
 *  - **Membership is decidable from the path alone.** Any directory two levels
 *    down whose first component is four hex digits is ours; anything else is
 *    not. That is what keeps a hand-made worktree — one holding work the user
 *    never committed — out of `list` and therefore out of `remove`.
 *
 * Pure: no process, no clock, no filesystem. Callers pass canonical paths, and
 * this module compares text the way `std::path::Path::strip_prefix` does.
 */

export type WorktreePlatform = "win32" | "posix";

function api(platform: WorktreePlatform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Codex `lib.rs:393-394`: length 4 and every byte an ASCII hex digit. */
export function isManagedBucket(name: string): boolean {
  return name.length === 4 && /^[0-9a-fA-F]{4}$/.test(name);
}

function segmentsOf(relative: string): ReadonlyArray<string> {
  return relative.split(/[\\/]/).filter((part) => part.length > 0 && part !== "." && part !== "..");
}

/**
 * Codex `lib.rs:382-397`. Exactly two segments below `root`, the first a
 * bucket. `..` in the relative path means "outside the pool", not a segment.
 */
export function hasManagedLayout(root: string, checkout: string, platform: WorktreePlatform): boolean {
  const relative = api(platform).relative(root, checkout);
  if (relative.length === 0 || relative.startsWith("..") || api(platform).isAbsolute(relative)) {
    return false;
  }
  const segments = segmentsOf(relative);
  return segments.length === 2 && isManagedBucket(segments[0] ?? "");
}

export function bucketPath(root: string, bucket: string, platform: WorktreePlatform): string {
  return api(platform).join(root, bucket);
}

export function checkoutPath(bucket: string, repositoryName: string, platform: WorktreePlatform): string {
  return api(platform).join(bucket, repositoryName);
}

/** Directory name of a repository root; Codex `lib.rs:72-74` rejects a root without one. */
export function repositoryNameOf(sourceRoot: string, platform: WorktreePlatform): string | undefined {
  const name = api(platform).basename(sourceRoot);
  return name.length > 0 ? name : undefined;
}

/**
 * `child` expressed relative to `root`, or `undefined` when it is not inside.
 * Codex `lib.rs:69-71` treats "outside" as a hard error, not an empty string:
 * an empty relative path would silently place the session at the pool root.
 */
export function relativeWithin(root: string, child: string, platform: WorktreePlatform): string | undefined {
  const relative = api(platform).relative(root, child);
  if (relative.startsWith("..") || api(platform).isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

export function isWithin(root: string, candidate: string, platform: WorktreePlatform): boolean {
  return relativeWithin(root, candidate, platform) !== undefined;
}

/**
 * Ownership record written into a checkout's git metadata directory.
 *
 * Codex stores `codex-thread.json` at `codex-rs/worktree/src/metadata.rs:19-27`
 * so that Desktop and the CLI agree on which thread owns a checkout. Trylo has
 * no Desktop to agree with, so the name and the field are ours; what is kept
 * is the *contract* the file exists to enforce — one owner, written once,
 * never silently replaced — plus an explicit version, because this file
 * outlives the process that wrote it.
 */
export const WORKTREE_OWNER_FILENAME = "trylo-worktree.json";

export const WORKTREE_OWNER_VERSION = 1;

export type WorktreeOwnerRecord = {
  readonly version: typeof WORKTREE_OWNER_VERSION;
  readonly ownerId: string;
};

/**
 * `deny_unknown_fields` in Codex `metadata.rs:23`, plus the non-empty check at
 * `:42`. A record from a newer writer must not be read as if we understood it,
 * and an empty owner would make "is this mine?" unanswerable.
 */
export function parseOwnerRecord(text: string): WorktreeOwnerRecord | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const keys = Object.keys(parsed);
  if (keys.some((key) => key !== "version" && key !== "ownerId")) {
    return undefined;
  }

  const record = parsed as { readonly version?: unknown; readonly ownerId?: unknown };
  if (record.version !== WORKTREE_OWNER_VERSION || typeof record.ownerId !== "string") {
    return undefined;
  }

  return record.ownerId.length > 0 ? { version: WORKTREE_OWNER_VERSION, ownerId: record.ownerId } : undefined;
}

export function ownerRecordText(ownerId: string): string {
  return `${JSON.stringify({ version: WORKTREE_OWNER_VERSION, ownerId })}\n`;
}

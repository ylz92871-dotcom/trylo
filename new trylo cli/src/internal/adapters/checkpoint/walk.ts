import { readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { CHECKPOINT_ALWAYS_IGNORED } from "../../ports/checkpoint.js";

/**
 * Workspace enumeration.
 *
 * Leaf-only and ignore-aware in one pass: descending into `node_modules` and
 * then filtering afterwards is the difference between copying a few thousand
 * files and copying a few hundred thousand.
 *
 * Paths are reported relative and POSIX-separated from here on. An absolute
 * path reaching the manifest would turn every snapshot into a map of the machine
 * it was taken on, and the digest into something non-reproducible.
 */

export type WalkedFile = {
  /** Workspace-relative with `/` separators. */
  readonly relativePath: string;
  /** Absolute and platform-native, for opening. Not persisted anywhere. */
  readonly absolutePath: string;
  readonly bytes: number;
};

export type WalkOutcome =
  | { readonly ok: true; readonly files: readonly WalkedFile[] }
  | { readonly ok: false; readonly detail: string };

export function ignoreSet(extra: readonly string[]): ReadonlySet<string> {
  return new Set([...CHECKPOINT_ALWAYS_IGNORED, ...extra]);
}

export function toRelativePath(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
}

export function listWorkspaceFiles(
  workspaceRoot: string,
  ignores: ReadonlySet<string>,
): WalkOutcome {
  const files: WalkedFile[] = [];
  const stack: string[] = [workspaceRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }

    let entries;

    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      return { ok: false, detail: describe(current, error) };
    }

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (!ignores.has(entry.name)) {
          stack.push(absolutePath);
        }
        continue;
      }

      if (!entry.isFile()) {
        // Symlinks, sockets, FIFOs: recording them as files would snapshot a
        // target outside the workspace, which the ignore rules cannot bound.
        continue;
      }

      let info;

      try {
        info = statSync(absolutePath);
      } catch (error) {
        return { ok: false, detail: describe(absolutePath, error) };
      }

      files.push({
        relativePath: toRelativePath(workspaceRoot, absolutePath),
        absolutePath,
        bytes: info.size,
      });
    }
  }

  files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1));

  return { ok: true, files };
}

function describe(target: string, error: unknown): string {
  const code = error instanceof Error && "code" in error ? String(error.code) : "EIO";
  return `${code} ${toRelativePath(path.dirname(target), target)}`;
}

/** Snapshot traversal yields between IO operations so stdio cancellation can run. */
export async function listSnapshotFiles(
  workspaceRoot: string,
  ignores: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<WalkOutcome> {
  const files: WalkedFile[] = [],
    stack = [workspaceRoot];
  try {
    while (stack.length) {
      signal?.throwIfAborted();
      const current = stack.pop();
      if (current === undefined) break;
      for (const entry of await readdir(current, { withFileTypes: true })) {
        signal?.throwIfAborted();
        const absolutePath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!ignores.has(entry.name)) stack.push(absolutePath);
          continue;
        }
        // The same leaf-only rule as restore: never follow links out of scope.
        if (!entry.isFile()) continue;
        const info = await stat(absolutePath);
        files.push({
          relativePath: toRelativePath(workspaceRoot, absolutePath),
          absolutePath,
          bytes: info.size,
        });
      }
    }
    files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
    return { ok: true, files };
  } catch (error) {
    return { ok: false, detail: describe(workspaceRoot, error) };
  }
}

import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { FileAccessMode } from "../../../ports/tools.js";

/**
 * Workspace containment, shared by every tool that touches the file system.
 *
 * Real paths are the authority, not an extra check: a lexical check alone loses
 * to symlinks and Windows junctions.
 *
 * Reads and writes need different guarantees, so there are two resolvers:
 *
 *  - `resolveInsideWorkspace` answers "is reading this safe", which is an
 *    all-or-nothing question about one existing path.
 *  - `resolveWriteTarget` additionally proves that every ancestor leading to
 *    the target stays inside the root. A write creates something new, and "the
 *    target does not exist yet" is exactly the case where the read resolver
 *    can only shrug and hand back a lexical path.
 */

export type PathDenyCode =
  | "invalid_path"
  | "path_outside_workspace"
  | "path_escapes_via_link"
  | "path_unverifiable"
  | "parent_missing";

export type PathVerdict =
  | { readonly ok: true; readonly absolutePath: string }
  | { readonly ok: false; readonly code: PathDenyCode };

const WINDOWS_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

function rejectsDevicePath(candidate: string): boolean {
  const normalized = candidate.replaceAll("/", "\\");
  if (normalized.startsWith("\\\\.\\") || normalized.startsWith("\\\\?\\")) {
    return true;
  }
  const first = normalized.split("\\")[0] ?? "";
  const stem = first.includes(":") ? first.slice(first.indexOf(":") + 1) : first;
  return WINDOWS_DEVICE_NAMES.has(stem.toLowerCase());
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length === 0 || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Preserve a workspace's lexical alias when its root is a junction/symlink. */
function resolveCandidate(root: string, rootReal: string, candidate: string, alias?: string): string {
  const lexicalRoot = path.resolve(alias ?? root);
  const lexical = path.resolve(lexicalRoot, candidate);
  return path.isAbsolute(candidate) && isInside(lexicalRoot, lexical)
    ? path.resolve(rootReal, path.relative(lexicalRoot, lexical)) : path.resolve(rootReal, candidate);
}

function withinScope(root: string, target: string, access: FileAccessMode): boolean {
  return access !== "workspace" || isInside(root, target);
}

/** Reviewed paths inside the workspace must stay there physically too. */
function targetScope(root: string, resolved: string, access: FileAccessMode): FileAccessMode {
  return access === "reviewed" && isInside(root, resolved) ? "workspace" : access;
}

function canonicalRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

/** `undefined` means the candidate already failed a check that needs no I/O. */
function failFast(candidate: string): PathDenyCode | undefined {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) {
    return "invalid_path";
  }
  // Absolute paths are aliases, never authority: both resolvers below still
  // prove lexical and real containment against the same workspace root.
  // Reject drive-relative Windows paths whose meaning depends on ambient cwd.
  if (rejectsDevicePath(candidate) || /^[a-z]:[^\\/]/i.test(candidate)) {
    return "path_outside_workspace";
  }
  return undefined;
}

export function resolveInsideWorkspace(root: string, candidate: string, access: FileAccessMode = "workspace", alias?: string): PathVerdict {
  const early = failFast(candidate);
  if (early !== undefined) {
    return { ok: false, code: early };
  }
  const rootReal = canonicalRoot(root);
  const resolved = resolveCandidate(root, rootReal, candidate, alias);
  access = targetScope(rootReal, resolved, access);
  if (!withinScope(rootReal, resolved, access)) {
    return { ok: false, code: "path_outside_workspace" };
  }
  let real: string;
  try {
    real = realpathSync.native(resolved);
  } catch (error) {
    // Only "the path is not there" may fall back to the lexical path: a target
    // that does not exist cannot be read, so containment of the resolved path
    // is all there is to prove. Any other failure (permissions, reparse points,
    // link loops) leaves containment unproven, so it fails closed instead of
    // handing back a path the caller would then follow.
    const code = (error as { readonly code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: true, absolutePath: resolved };
    }
    return { ok: false, code: "path_unverifiable" };
  }
  if (!withinScope(rootReal, real, access)) {
    return { ok: false, code: "path_escapes_via_link" };
  }
  return { ok: true, absolutePath: real };
}

/** The nearest existing ancestor at or above `target`, bounded by `root`. */
function deepestExistingAncestor(target: string, root: string): string | undefined {
  let probe = path.dirname(target);
  for (;;) {
    if (existsSync(probe)) {
      return probe;
    }
    const parent = path.dirname(probe);
    if (parent === probe || !isInside(root, probe)) {
      return undefined;
    }
    probe = parent;
  }
}

/**
 * Resolves a path that is about to be created or replaced.
 *
 * The chain here is ancestor by ancestor: each existing ancestor is real-pathed
 * and proven to be inside the root before the remainder is appended to it, so a
 * link planted at any level is caught at that level rather than discovered
 * after something has been opened for writing.
 */
export function resolveWriteTarget(root: string, candidate: string, access: FileAccessMode = "workspace", alias?: string): PathVerdict {
  const early = failFast(candidate);
  if (early !== undefined) {
    return { ok: false, code: early };
  }
  const rootReal = canonicalRoot(root);
  const resolved = resolveCandidate(root, rootReal, candidate, alias);
  access = targetScope(rootReal, resolved, access);
  if (!withinScope(rootReal, resolved, access)) {
    return { ok: false, code: "path_outside_workspace" };
  }
  const ancestor = deepestExistingAncestor(resolved, access === "workspace" ? rootReal : path.parse(resolved).root);
  if (ancestor === undefined) {
    return { ok: false, code: "parent_missing" };
  }
  let ancestorReal: string;
  try {
    ancestorReal = realpathSync.native(ancestor);
  } catch {
    return { ok: false, code: "path_unverifiable" };
  }
  if (!withinScope(rootReal, ancestorReal, access)) {
    return { ok: false, code: "path_escapes_via_link" };
  }
  const remainder = path.relative(ancestor, resolved);
  const target = remainder.length === 0 ? ancestorReal : path.join(ancestorReal, remainder);
  if (!withinScope(rootReal, target, access)) {
    return { ok: false, code: "path_outside_workspace" };
  }
  const parentProblem = requireDirectoryIfPresent(path.dirname(target));
  if (parentProblem !== undefined) {
    return { ok: false, code: parentProblem };
  }
  try {
    if (lstatSync(target).isSymbolicLink()) {
      const real = realpathSync.native(target);
      if (!withinScope(rootReal, real, access)) {
        return { ok: false, code: "path_escapes_via_link" };
      }
    }
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return { ok: false, code: "path_unverifiable" };
    }
  }
  return { ok: true, absolutePath: target };
}

/**
 * A write may create its parent chain at execution: the ancestor validation
 * above has already proven that the whole chain hangs inside the root, so the
 * directories being made are known-good before they exist. A parent that is
 * present as a non-directory, buried behind a file component, or dangling as
 * a broken symlink is still refused — those are not "missing", they are wrong.
 */
function requireDirectoryIfPresent(candidate: string): PathDenyCode | undefined {
  try {
    return statSync(candidate).isDirectory() ? undefined : "parent_missing";
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code !== "ENOENT") {
      return "parent_missing";
    }
    try {
      // ENOENT from stat but success from lstat means a dangling symlink.
      lstatSync(candidate);
      return "parent_missing";
    } catch {
      return undefined;
    }
  }
}

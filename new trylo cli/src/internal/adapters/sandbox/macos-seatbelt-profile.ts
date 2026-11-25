import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { IsolationFilePolicy } from "../../ports/isolation.js";

export const MACOS_SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";

function absentPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Resolve new path suffixes against the nearest existing physical ancestor. */
function canonicalPath(input: string): string {
  try { return realpathSync.native(input); }
  catch (error) {
    const parent = path.dirname(input);
    // A dangling link must not be treated as a missing path under its parent.
    if (!absentPath(error) || parent === input || lstatSync(input, { throwIfNoEntry: false })?.isSymbolicLink()) throw error;
    return path.join(canonicalPath(parent), path.basename(input));
  }
}

function absolutePath(input: string): string {
  if (!path.isAbsolute(input) || input.includes("\0")) throw new Error(`Seatbelt needs an absolute filesystem path: ${input}`);
  return input;
}

function covers(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function denyPaths(paths: readonly string[]): string[] {
  const names = paths.map(absolutePath);
  return [...new Set([...names.map(name => path.normalize(name)), ...names.map(canonicalPath)])];
}

/** Filesystem paths are sandbox-exec parameters, never parsed SBPL. */
export function macosSeatbeltPrefix(policy: IsolationFilePolicy): readonly string[] {
  const roots = [...new Set(policy.writableRoots.map(root => realpathSync.native(absolutePath(root))))];
  const protectedReads = denyPaths(policy.denyReadPaths);
  const protectedWrites = denyPaths([...policy.denyWritePaths, ...protectedReads]);
  const parameters: string[] = [];
  const filter = (kind: "literal" | "subpath", name: string): string => {
    const key = `TRYLO_PATH_${parameters.length / 2}`;
    parameters.push("-D", `${key}=${name}`);
    return `(${kind} (param "${key}"))`;
  };

  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow file-read* process-exec* process-fork sysctl-read)",
    "(allow signal (target self))",
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))',
    '(allow file-write* (literal "/dev/null"))',
  ];

  for (const root of roots) profile.push(`(allow file-write* ${filter("subpath", root)})`);
  for (const target of protectedReads) profile.push(`(deny file-read* ${filter("subpath", target)})`);
  for (const target of protectedWrites) profile.push(`(deny file-write* ${filter("subpath", target)})`);

  // Keep a permitted rename of a parent from moving a carve-out into an open path.
  const ancestors = new Set<string>();
  for (const target of protectedWrites) {
    let ancestor = path.dirname(target);
    while (roots.some(root => covers(root, ancestor))) {
      ancestors.add(ancestor);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  for (const ancestor of ancestors) profile.push(`(deny file-write-unlink ${filter("literal", ancestor)})`);

  return [MACOS_SEATBELT_EXECUTABLE, "-p", profile.join("\n"), ...parameters];
}

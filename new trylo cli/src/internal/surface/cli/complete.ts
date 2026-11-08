/**
 * Completing a file path as it is typed.
 *
 * The person is typing a path in the middle of a sentence they are still
 * writing, so this completes only the word under the cursor and never touches
 * the rest of the line: a completion that rewrote what they said would be
 * editing their message, which is not what Tab is for.
 *
 * Directories come back with a trailing separator so one Tab can walk a whole
 * path — a candidate without it would make the next level unreachable without
 * typing the slash by hand.
 *
 * Pure: the directory listing is passed in, so this is testable without a
 * filesystem, and the composition root decides how directories are read.
 */

export type DirEntry = {
  readonly name: string;
  readonly isDirectory: boolean;
};

/** The last whitespace-separated word of the line: the thing being completed. */
function lastWord(line: string): string {
  const match = /[^\s]*$/.exec(line);
  return match === null ? "" : match[0];
}

/**
 * Completions for the word being typed.
 *
 * Returns whole replacement paths, not the missing tail: the caller replaces
 * the word it extracted, and a relative tail would be appended to a word that
 * is still there.
 */
export function pathCompletions(
  line: string,
  cwd: string,
  readDir: (absolutePath: string) => ReadonlyArray<DirEntry>,
): ReadonlyArray<string> {
  const partial = lastWord(line);
  if (partial.length === 0) {
    return [];
  }

  const cut = Math.max(partial.lastIndexOf("/"), partial.lastIndexOf("\\"));
  const dirPart = cut >= 0 ? partial.slice(0, cut + 1) : "";
  const prefix = cut >= 0 ? partial.slice(cut + 1) : partial;
  const absolute = dirPart.length === 0 ? cwd : join(cwd, dirPart);
  const entries = readDir(absolute);

  return entries
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => `${dirPart}${entry.name}${entry.isDirectory ? "/" : ""}`)
    .sort();
}

/** Joining that tolerates the path already being absolute. */
function join(base: string, part: string): string {
  if (part.startsWith("/") || part.startsWith("\\") || /^[A-Za-z]:/.test(part)) {
    return part;
  }
  return base.endsWith("/") || base.endsWith("\\") ? `${base}${part}` : `${base}/${part}`;
}

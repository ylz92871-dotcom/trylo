/**
 * Filesystem path to `file://` URI, both directions, once.
 *
 * The rule that matters: **inside Trylo a path is workspace-relative with `/`
 * separators; inside the language server it is a URI.** Two spellings of the same
 * file, converted in exactly one place, is what keeps a stored `LspLocation`
 * readable and what stops `D:\a\..\b` from becoming a different answer from
 * `D:/b`.
 */

const WINDOWS_DRIVE = /^[A-Za-z]:/;

/**
 * A workspace-relative path against its root. The single spelling rule, kept
 * beside the URI conversion because they must agree: callers that join
 * elsewhere drift into `D:/a/../b` versus `D:/b` being two different files.
 */
export function resolveWorkspacePath(workspaceRoot: string, relative: string): string {
  const normalized = relative.replaceAll("\\", "/");
  const root = workspaceRoot.replaceAll("\\", "/").replace(/\/$/, "");
  if (normalized.startsWith("/") || WINDOWS_DRIVE.test(normalized)) {
    return normalized;
  }
  return `${root}/${normalized}`;
}

/**
 * Absolute or workspace-relative path to a `file://` URI.
 *
 * A relative path is resolved against `workspaceRoot` first: without the
 * root the conversion invents `file:///b.ts`, a document no server can
 * resolve to a file on this disk. That silent invention is what sent every
 * relative query to a phantom document until this parameter existed.
 */
export function pathToUri(path: string, workspaceRoot: string): string {
  const absolute = resolveWorkspacePath(workspaceRoot, path);
  // A drive path needs the slash *before* the drive letter: `file:///D:/x`.
  // Emitting `file://D:/x` parses as host `d` and is refused by most servers,
  // so this is a correctness requirement, not a formatting preference.
  const withLeadingSlash = absolute.startsWith("/") ? absolute : `/${absolute}`;
  const encoded = withLeadingSlash
    .split("/")
    .map((segment) => encodeURIComponent(segment).replaceAll("%3A", ":"))
    .join("/");

  return `file://${encoded}`;
}

/**
 * `file://` URI to a path. A non-file URI is refused rather than guessed: an
 * `untitled:` or `jdt://` document has no path on this disk, and inventing one
 * would produce a location that points at a file the user never opened.
 */
export function uriToPath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) {
    return undefined;
  }

  const withoutScheme = uri.slice("file://".length);
  const decoded = safeDecode(withoutScheme);
  // A drive path comes back as `/D:/...` because the URI has an empty authority.
  // The slash belongs to the URI syntax, not to the path, so it is stripped here
  // — otherwise one file would have two spellings depending on the direction.
  const normalized = decoded.replaceAll("\\", "/");

  // The URI has an empty authority, so a drive path arrives with a leading slash
  // (`file:///D:/x` -> `/D:/x`). That slash is URI syntax, not part of the path.
  // Testing *after* removing it is what makes the drive case work: `^[A-Za-z]:`
  // cannot match `/D:/x`, which is exactly the bug this guard exists to prevent.
  if (normalized.startsWith("/") && WINDOWS_DRIVE.test(normalized.slice(1))) {
    return normalized.slice(1);
  }

  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    // A malformed escape means the server sent a URI we cannot faithfully read.
    // Returning the raw text keeps the failure visible as a wrong path rather
    // than hiding it behind a thrown error from a conversion helper.
    return value;
  }
}

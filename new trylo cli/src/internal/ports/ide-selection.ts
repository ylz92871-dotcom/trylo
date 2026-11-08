/**
 * What a person has selected in their editor, in Trylo's words.
 *
 * Reused from the legacy CLI's IDE integration, which speaks MCP: the editor
 * exposes a server named `ide` and pushes a `selection_changed` notification.
 * That transport is **not** reproduced here — it belongs to the MCP runtime, and
 * duplicating a WebSocket client beside it would create a second way to reach an
 * editor, which is the exact "照名字再造第二套服务" the package contract forbids.
 * What is reproduced is the part that is genuinely ours: what a selection *is*,
 * and what it is allowed to become.
 *
 * The design problem this file solves is small and real. A selection arrives as
 * `{start:{line,character}, end:{line,character}, text, filePath}` and has to
 * become text a turn can carry. Three things have to be decided, and each has one
 * right answer:
 *
 *   - an **empty** selection is not a selection; it is the cursor, and attaching
 *     "the line you are on" unasked is noise;
 *   - an end position of `character: 0` on a later line means the selection ends
 *     at the *start* of that line, so counting it would report one line too many;
 *   - a selection whose file is unknown, or whose text is absent, cannot be
 *     expanded by us — the caller must be told, because silently attaching
 *     nothing produces a turn that looks complete and is missing its context.
 */

/** A position in a file. Zero-based, matching both LSP and the protocol. */
export type SelectionPoint = {
  readonly line: number;
  readonly character: number;
};

export type RawSelection = {
  readonly selection: {
    readonly start: SelectionPoint;
    readonly end: SelectionPoint;
  } | null;
  readonly text?: string;
  readonly filePath?: string;
};

/** A selection that is worth attaching to a turn. */
export type IdeSelection = {
  /** Workspace-relative, `/` separators — the spelling `read_file` accepts. */
  readonly filePath: string;
  /** Zero-based first line of the selection. */
  readonly startLine: number;
  /** How many lines the selection covers; always at least 1. */
  readonly lineCount: number;
  readonly text: string;
  /** True when the text was cut to fit a turn, so the screen can say so. */
  readonly truncated: boolean;
};

export const MAX_SELECTION_BYTES = 64 * 1024;

export type SelectionOutcome =
  | { readonly ok: true; readonly selection: IdeSelection }
  /**
   * `empty` — the editor reported a cursor, not a selection. Not an error: it is
   * the normal state of an editor nobody has dragged in.
   */
  | { readonly ok: false; readonly reason: "empty" }
  /** The notification arrived without a usable file or text. */
  | { readonly ok: false; readonly reason: "incomplete"; readonly detail: string };

/**
 * Normalise one editor notification.
 *
 * @param workspacePath resolves the editor's absolute path to a
 * workspace-relative one. Editors report absolute paths and may use either
 * separator; both are handled by the caller's resolver, because only the caller
 * knows the workspace root.
 */
export function readSelection(
  raw: RawSelection,
  workspacePath: (absolute: string) => string | undefined,
  maxBytes: number = MAX_SELECTION_BYTES,
): SelectionOutcome {
  const text = raw.text;
  if (text === undefined || text.length === 0) {
    // A collapsed cursor, or an editor that cleared the selection. Both mean
    // "nothing to attach", and neither is worth an error the user must read.
    return { ok: false, reason: "empty" };
  }

  if (raw.filePath === undefined || raw.filePath.length === 0) {
    // Attaching text with no path would hand the model a quotation it cannot
    // attribute or re-read. Refusing is the only honest option.
    return { ok: false, reason: "incomplete", detail: "selection carried no file path" };
  }

  const filePath = workspacePath(raw.filePath);
  if (filePath === undefined) {
    return { ok: false, reason: "incomplete", detail: `${raw.filePath} is outside the workspace` };
  }

  const start = raw.selection?.start;
  let startLine = 0;
  let lineCount = 1;

  if (start !== undefined && raw.selection !== null) {
    startLine = start.line;
    const end = raw.selection.end;

    lineCount = end.line - start.line + 1;

    // Ending at character 0 of a later line means "up to the start of that line",
    // so that line is not actually part of the selection.
    if (end.character === 0 && lineCount > 1) {
      lineCount -= 1;
    }
  }

  const truncated = text.length > maxBytes;

  return {
    ok: true,
    selection: {
      filePath,
      startLine,
      lineCount: Math.max(1, lineCount),
      text: truncated ? text.slice(0, maxBytes) : text,
      truncated,
    },
  };
}

/**
 * The text a turn carries. Same shape `@file` produces, so a selection and a
 * mention are indistinguishable to the model — one way to say "here is a file",
 * not two that can drift apart.
 */
export function selectionNote(selection: IdeSelection): string {
  const where = `${selection.filePath}:${selection.startLine + 1}`;
  const size = selection.lineCount === 1 ? "1 line" : `${selection.lineCount} lines`;
  return selection.truncated ? `${where} (${size}, truncated)` : `${where} (${size})`;
}

export function renderSelection(selection: IdeSelection): string {
  return `<file path="${selection.filePath}" selection="${selection.startLine}-${selection.startLine + selection.lineCount - 1}"${selection.truncated ? " note=\"truncated\"" : ""}>\n${selection.text}\n</file>`;
}

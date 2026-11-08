/** Shared preview policy for text mode and the terminal frame. Full text stays on the wire. */
export const MAX_TOOL_OUTPUT_LINES = 5;
export const MAX_OUTPUT_LINE_CHARS = 160;

export function foldToolOutput(output: string): ReadonlyArray<string> {
  if (output.trim().length === 0) {
    return [];
  }

  const rows = output.replaceAll("\r\n", "\n").replace(/\s+$/, "").split("\n");
  const shown = rows.slice(0, MAX_TOOL_OUTPUT_LINES).map(row =>
    row.length <= MAX_OUTPUT_LINE_CHARS ? row : `${row.slice(0, MAX_OUTPUT_LINE_CHARS - 1)}…`,
  );
  const hidden = rows.length - shown.length;

  return hidden > 0 ? [...shown, `... ${hidden} more lines`] : shown;
}

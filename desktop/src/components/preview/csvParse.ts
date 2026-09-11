// Trylo Desktop — minimal CSV/TSV parser for the table preview.
//
// WHY a hand-rolled parser instead of a dependency: the preview only
// needs RFC-4180 basics (quoted fields, escaped quotes, CRLF) for a
// read-only glance. Pulling papaparse/xlsx for this one view would add
// a permanent dependency for ~40 lines of logic. If the preview ever
// needs full spreadsheet support (.xlsx), that deserves its own
// evaluated dependency — not scope creep here.
//
// Pure / IO-free. The caller caps rows/cols for display.

export interface ParsedCsv {
  readonly rows: readonly (readonly string[])[];
  /** True when the input was cut off at maxChars (more data exists). */
  readonly truncated: boolean;
}

const DEFAULT_MAX_CHARS = 512 * 1024;
const DEFAULT_MAX_ROWS = 2000;

/** Parse CSV (or TSV when delimiter is '\t') into rows of fields. */
export function parseDelimited(
  content: string,
  delimiter: ',' | '\t' = ',',
  options?: { readonly maxChars?: number; readonly maxRows?: number },
): ParsedCsv {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const maxRows = options?.maxRows ?? DEFAULT_MAX_ROWS;
  const truncated = content.length > maxChars;
  const text = truncated ? content.slice(0, maxChars) : content;

  const rows: string[][] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = (): void => {
    fields.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(fields);
    fields = [];
  };

  while (i < text.length && rows.length < maxRows) {
    const ch = text[i];
    if (ch === undefined) break;
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === delimiter) {
      pushField();
      i += 1;
    } else if (ch === '\r') {
      // CRLF or lone CR both end the row; the LF (if any) is skipped.
      pushRow();
      i += text[i + 1] === '\n' ? 2 : 1;
    } else if (ch === '\n') {
      pushRow();
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  // Flush a trailing partial row (a file not ending in newline still
  // has content). An empty input yields zero rows — the caller renders
  // the empty-state, not a phantom single cell.
  if (field !== '' || fields.length > 0) pushRow();

  return { rows, truncated: truncated || rows.length >= maxRows };
}

/** Delimiter implied by the file extension. */
export function delimiterFor(path: string): ',' | '\t' {
  return path.toLowerCase().endsWith('.tsv') ? '\t' : ',';
}

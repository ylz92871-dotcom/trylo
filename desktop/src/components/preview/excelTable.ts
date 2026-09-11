// Trylo Desktop — workbook → plain-table projection (pure).
//
// WHY a separate pure module: SheetJS does the heavy parsing, but the
// "first N rows × M cols as strings" policy is ours and unit-testable
// without fixtures — the test builds a workbook in memory with the
// same library. The React component only renders; policy lives here.

import { read, utils, type WorkSheet } from 'xlsx';

export const MAX_SHEET_ROWS = 200;
export const MAX_SHEET_COLS = 20;
const MAX_SHEETS = 32;

export interface SheetTable {
  readonly name: string;
  /** First row is the header. Every cell already stringified. */
  readonly rows: readonly (readonly string[])[];
  readonly totalRows: number;
  readonly folded: boolean;
}

export interface WorkbookTables {
  readonly sheets: readonly SheetTable[];
  readonly foldedSheets: boolean;
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toLocaleString();
  return '';
}

/** Parse workbook bytes into capped string tables. Never throws. */
export function workbookToTables(bytes: Uint8Array): WorkbookTables {
  try {
    const workbook = read(bytes, { type: 'array' });
    const names = workbook.SheetNames.slice(0, MAX_SHEETS);
    const sheets: SheetTable[] = names.map((name) =>
      sheetToTable(name, workbook.Sheets[name]),
    );
    return {
      sheets,
      foldedSheets: workbook.SheetNames.length > MAX_SHEETS,
    };
  } catch {
    // Corrupt / password-protected / non-spreadsheet bytes: the React
    // side renders an honest error, never a crash.
    return { sheets: [], foldedSheets: false };
  }
}

function sheetToTable(name: string, sheet: WorkSheet | undefined): SheetTable {
  if (!sheet) return { name, rows: [], totalRows: 0, folded: false };
  // raw:false keeps Excel's display formatting (dates, percents).
  const raw = utils.sheet_to_json<readonly unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: false,
  });
  const totalRows = raw.length;
  const folded =
    totalRows > MAX_SHEET_ROWS ||
    raw.some((row) => row.length > MAX_SHEET_COLS);
  const rows = raw
    .slice(0, MAX_SHEET_ROWS)
    .map((row) => row.slice(0, MAX_SHEET_COLS).map(cellToString));
  return { name, rows, totalRows, folded };
}

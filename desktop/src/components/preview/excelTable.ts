// Trylo Desktop — workbook → plain-table projection (pure).
//
// WHY a separate pure module: SheetJS does the heavy parsing, but the
// "first N rows × M cols as strings" policy is ours and unit-testable
// without fixtures — the test builds a workbook in memory with the
// same library. The React component only renders; policy lives here.

import { read, utils, type WorkSheet, type WorkBook } from 'xlsx';

export const MAX_SHEET_ROWS = 200;
export const MAX_SHEET_COLS = 20;
const MAX_SHEETS = 32;

export interface SheetTable {
  readonly name: string;
  /** Formatted cell values in a bounded window, including blank rows. */
  readonly rows: readonly (readonly string[])[];
  readonly totalRows: number;
  readonly totalCols: number;
  readonly rowOffset: number;
  readonly colOffset: number;
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

export function readWorkbook(bytes: Uint8Array): WorkBook {
  return read(bytes, { type: 'array', cellStyles: false, bookVBA: false });
}

/** Parse workbook bytes into capped string tables. Never throws. */
export function workbookToTables(bytes: Uint8Array): WorkbookTables {
  try {
    const workbook = readWorkbook(bytes);
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

export function sheetToTable(name: string, sheet: WorkSheet | undefined, rowOffset = 0, colOffset = 0): SheetTable {
  if (!sheet?.['!ref']) return { name, rows: [], totalRows: 0, totalCols: 0, rowOffset: 0, colOffset: 0, folded: false };
  const bounds = utils.decode_range(sheet['!ref']);
  const totalRows = bounds.e.r + 1;
  const totalCols = bounds.e.c + 1;
  const row = Math.max(0, Math.min(rowOffset, totalRows - 1));
  const col = Math.max(0, Math.min(colOffset, totalCols - 1));
  // raw:false keeps Excel's display formatting (dates, percents).
  const raw = utils.sheet_to_json<readonly unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: false,
    blankrows: true,
    range: { s: { r: row, c: col }, e: { r: Math.min(totalRows - 1, row + MAX_SHEET_ROWS - 1), c: Math.min(totalCols - 1, col + MAX_SHEET_COLS - 1) } },
  });
  const folded = totalRows > MAX_SHEET_ROWS || totalCols > MAX_SHEET_COLS;
  const rows = raw
    .slice(0, MAX_SHEET_ROWS)
    .map((row) => row.slice(0, MAX_SHEET_COLS).map(cellToString));
  return { name, rows, totalRows, totalCols, rowOffset: row, colOffset: col, folded };
}

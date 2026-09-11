// Trylo Desktop — XlsxPreview (base capability).
//
// SheetJS CE (Apache-2.0) parses the workbook; policy (caps, display
// formatting) lives in excelTable.ts. Sheet tabs switch the visible
// table. Values only — charts, images, and macros are outside a
// read-only glance and stay in Excel.

import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { usePreviewBytes } from './usePreviewBytes';
import { workbookToTables } from './excelTable';

export interface XlsxPreviewProps {
  readonly path: string;
}

export function XlsxPreview(props: XlsxPreviewProps): ReactElement {
  const bytesState = usePreviewBytes(props.path);
  const [sheetIndex, setSheetIndex] = useState(0);

  const tables = useMemo(
    () => (bytesState.status === 'ready' ? workbookToTables(bytesState.bytes) : undefined),
    [bytesState],
  );

  if (bytesState.status === 'loading' || !tables) {
    return <div className="preview__empty">Loading spreadsheet…</div>;
  }
  if (bytesState.status === 'error') {
    return <div className="preview__empty">Could not load spreadsheet: {bytesState.message}</div>;
  }
  if (tables.sheets.length === 0) {
    return <div className="preview__empty">Could not parse this workbook — it may be corrupt or password-protected.</div>;
  }

  const sheet = tables.sheets[Math.min(sheetIndex, tables.sheets.length - 1)];
  if (!sheet) {
    return <div className="preview__empty">No sheets to show.</div>;
  }
  const [header, ...body] = sheet.rows;

  return (
    <div className="preview__paged" role="region" aria-label="Spreadsheet preview">
      {tables.sheets.length > 1 && (
        <div className="preview__toolbar preview__toolbar--scroll" role="tablist" aria-label="Sheets">
          {tables.sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              role="tab"
              aria-selected={i === Math.min(sheetIndex, tables.sheets.length - 1)}
              className={i === Math.min(sheetIndex, tables.sheets.length - 1) ? 'preview__tab--active' : undefined}
              onClick={() => setSheetIndex(i)}
              title={s.name}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="preview__table-wrap">
        <table className="preview__table">
          <thead>
            <tr>
              {header?.map((cell, i) => (
                <th key={i}>{cell === '' ? ' ' : cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{cell === '' ? ' ' : cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {(sheet.folded || tables.foldedSheets) && (
          <div className="preview__fold-note">
            Showing {sheet.rows.length} of {sheet.totalRows} rows
            {tables.foldedSheets ? ' (some sheets hidden)' : ''} — open in Excel for the full workbook.
          </div>
        )}
      </div>
    </div>
  );
}

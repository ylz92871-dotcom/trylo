// Trylo Desktop — CsvPreview (base capability).
//
// Read-only glance at `.csv` / `.tsv` deliverables (e.g. budget
// tables from Work). First row is treated as the header. Display is
// capped (rows × cols) so a multi-MB export can't freeze the rail —
// the cap note tells the user data exists beyond the fold.

import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { delimiterFor, parseDelimited } from './csvParse';

const MAX_DISPLAY_ROWS = 200;
const MAX_DISPLAY_COLS = 20;

export interface CsvPreviewProps {
  readonly path: string;
  readonly content: string;
}

export function CsvPreview(props: CsvPreviewProps): ReactElement {
  const table = useMemo(() => {
    const parsed = parseDelimited(props.content, delimiterFor(props.path));
    const rows = parsed.rows.slice(0, MAX_DISPLAY_ROWS);
    const colCount = Math.min(
      MAX_DISPLAY_COLS,
      rows.reduce((widest, row) => Math.max(widest, row.length), 0),
    );
    const folded =
      parsed.truncated ||
      parsed.rows.length > MAX_DISPLAY_ROWS ||
      rows.some((row) => row.length > MAX_DISPLAY_COLS);
    return { rows, colCount, folded, total: parsed.rows.length, truncated: parsed.truncated };
  }, [props.content, props.path]);

  if (table.rows.length === 0) {
    return <div className="preview__empty">Empty table — no rows to show.</div>;
  }

  const [header, ...body] = table.rows;
  return (
    <div className="preview__table-wrap" role="region" aria-label="Table preview">
      <table className="preview__table">
        <thead>
          <tr>
            {header?.slice(0, table.colCount).map((cell, i) => (
              <th key={i}>{cell === '' ? ' ' : cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.slice(0, table.colCount).map((cell, c) => (
                <td key={c}>{cell === '' ? ' ' : cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.folded && (
        <div className="preview__fold-note">
          Showing {Math.min(table.total, MAX_DISPLAY_ROWS)} of {table.total} rows
          {table.truncated ? ' (file truncated)' : ''} — open the file for the full data.
        </div>
      )}
    </div>
  );
}

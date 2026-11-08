import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { utils } from 'xlsx';
import { usePreviewBytes } from './usePreviewBytes';
import { MAX_SHEET_ROWS, MAX_SHEET_COLS, readWorkbook, sheetToTable } from './excelTable';
import { PreviewFailure } from './PreviewFailure';

export interface XlsxPreviewProps { readonly path: string; readonly allowedRoot?: string }
export function XlsxPreview({ path, allowedRoot }: XlsxPreviewProps): ReactElement {
  const state = usePreviewBytes(path, undefined, allowedRoot);
  const bytes = state.status === 'ready' ? state.bytes : undefined;
  const [selection, setSelection] = useState({ path, index: 0, row: 0, col: 0 });
  const current = selection.path === path ? selection : { path, index: 0, row: 0, col: 0 };
  const parsed = useMemo(() => {
    if (!bytes) return undefined;
    try { return { workbook: readWorkbook(bytes) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, [bytes]);
  const sheet = useMemo(() => {
    const book = parsed?.workbook;
    const name = book?.SheetNames[current.index];
    return book && name ? sheetToTable(name, book.Sheets[name], current.row, current.col) : undefined;
  }, [parsed, current.index, current.row, current.col]);
  if (state.status === 'error') return <PreviewFailure error={state.message} />;
  if (state.status === 'loading' || !parsed) return <div className="preview__empty" role="status">正在读取表格…</div>;
  if (parsed.error || !parsed.workbook || !sheet) return <div className="preview__empty" role="alert">无法解析表格：{parsed.error ?? '文件为空、损坏或受密码保护'}</div>;
  const move = (row: number, col: number): void => setSelection({ ...current, row, col });
  const shownCols = Math.min(MAX_SHEET_COLS, sheet.totalCols - sheet.colOffset);
  return <div className="preview__paged preview__workbook" role="region" aria-label="Spreadsheet preview">
    <div className="preview__toolbar" aria-label="Table range">
      <button type="button" disabled={current.row === 0} onClick={() => move(Math.max(0, current.row - MAX_SHEET_ROWS), current.col)}>上一段行</button>
      <span>{sheet.totalRows ? sheet.rowOffset + 1 : 0}–{Math.min(sheet.totalRows, sheet.rowOffset + MAX_SHEET_ROWS)} / {sheet.totalRows} 行</span>
      <button type="button" disabled={current.row + MAX_SHEET_ROWS >= sheet.totalRows} onClick={() => move(current.row + MAX_SHEET_ROWS, current.col)}>下一段行</button>
      <button type="button" disabled={current.col === 0} onClick={() => move(current.row, Math.max(0, current.col - MAX_SHEET_COLS))}>前面列</button>
      <span>{sheet.totalCols ? `${utils.encode_col(sheet.colOffset)}–${utils.encode_col(sheet.colOffset + shownCols - 1)}` : '0'} / {sheet.totalCols} 列</span>
      <button type="button" disabled={current.col + MAX_SHEET_COLS >= sheet.totalCols} onClick={() => move(current.row, current.col + MAX_SHEET_COLS)}>后面列</button>
    </div>
    <div className="preview__table-wrap">
      <table className="preview__table"><thead><tr><th aria-label="Row" />
        {Array.from({ length: shownCols }, (_, i) => <th key={i}>{utils.encode_col(sheet.colOffset + i)}</th>)}
      </tr></thead><tbody>
        {sheet.rows.map((row, r) => <tr key={r}><th scope="row">{sheet.rowOffset + r + 1}</th>
          {Array.from({ length: shownCols }, (_, c) => <td key={c}>{row[c] || ' '}</td>)}
        </tr>)}
      </tbody></table>
      {!sheet.totalRows && <div className="preview__empty">空白工作表</div>}
    </div>
    <div className="preview__sheet-tabs" role="tablist" aria-label="Sheets">
      {parsed.workbook.SheetNames.map((name, index) => <button type="button" key={name} role="tab" aria-selected={index === current.index}
        onClick={() => setSelection({ path, index, row: 0, col: 0 })}>{name}</button>)}
    </div>
  </div>;
}

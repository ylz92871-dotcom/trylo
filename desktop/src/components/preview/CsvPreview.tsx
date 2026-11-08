import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { delimiterFor } from './csvParse';
import { delimitedWindow, indexDelimited } from './csvIndex';

const ROWS = 200;
const COLS = 20;
export function CsvPreview({ path, content }: { path: string; content: string }): ReactElement {
  const delimiter = delimiterFor(path);
  const index = useMemo(() => indexDelimited(content, delimiter), [content, delimiter]);
  const [position, setPosition] = useState({ row: 0, col: 0 });
  const row = Math.min(position.row, Math.max(0, index.starts.length - 2));
  const col = Math.min(position.col, Math.max(0, index.columns - 1));
  const header = useMemo(() => delimitedWindow(content, index.starts, 0, 1, delimiter)[0] ?? [], [content, index, delimiter]);
  const rows = useMemo(() => delimitedWindow(content, index.starts, row + 1, ROWS, delimiter), [content, index, row, delimiter]);
  if (!index.starts.length) return <div className="preview__empty">表格为空。</div>;
  return <div className="preview__paged">
    <div className="preview__toolbar" role="toolbar" aria-label="表格导航">
      <span>{Math.max(0, index.starts.length - 1).toLocaleString()} 行 · {index.columns} 列</span>
      <button type="button" disabled={!row} onClick={() => setPosition({ row: Math.max(0, row - ROWS), col })}>上一页</button>
      <label>起始行 <input aria-label="数据起始行" type="number" min={1} max={Math.max(1, index.starts.length - 1)} value={row + 1} onChange={(e) => setPosition({ row: Math.max(0, Math.min(index.starts.length - 2, Number(e.target.value) - 1)), col })} /></label>
      <button type="button" disabled={row + ROWS >= index.starts.length - 1} onClick={() => setPosition({ row: row + ROWS, col })}>下一页</button>
      <button type="button" disabled={!col} onClick={() => setPosition({ row, col: Math.max(0, col - COLS) })}>前 {COLS} 列</button>
      <span>列 {col + 1}–{Math.min(col + COLS, index.columns)}</span>
      <button type="button" disabled={col + COLS >= index.columns} onClick={() => setPosition({ row, col: col + COLS })}>后 {COLS} 列</button>
    </div>
    <div className="preview__table-wrap" role="region" aria-label="Table preview" tabIndex={0}>
      <table className="preview__table"><thead><tr><th scope="col">行</th>{Array.from({ length: Math.min(COLS, index.columns - col) }, (_, i) => <th scope="col" key={i}>{header[col + i] || `列 ${col + i + 1}`}</th>)}</tr></thead>
      <tbody>{rows.map((cells, r) => <tr key={row + r}><th scope="row">{row + r + 1}</th>{Array.from({ length: Math.min(COLS, index.columns - col) }, (_, c) => <td key={c}>{cells[col + c] || ' '}</td>)}</tr>)}</tbody></table>
    </div>
  </div>;
}

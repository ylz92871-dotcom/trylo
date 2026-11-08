import type { ReactElement } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus, Scan } from 'lucide-react';

export function PdfReaderControls({ page, pages, pageInput, onPageInput, onCommit, scale, onZoom, onFit, slides }: {
  page: number; pages: number; pageInput: string; onPageInput: (value: string) => void;
  onCommit: (value: number) => void; scale: number; onZoom: (factor: number) => void;
  onFit: (value: 'page-width' | 'page-fit') => void; slides: boolean;
}): ReactElement {
  return <footer className="preview__reader-status" aria-label="阅读控制">
    <div className="preview__reader-pagination">
      <button type="button" aria-label="Previous page" title="上一页" disabled={page <= 1 || !pages} onClick={() => onCommit(page - 1)}><ChevronLeft size={15} /></button>
      <input className="preview__page-input" aria-label="Page number" inputMode="numeric" value={pageInput} disabled={!pages}
        onChange={event => onPageInput(event.target.value)} onBlur={() => onCommit(Number(pageInput) || page)}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
      <span>/ {pages || '…'}<span className="preview__page-unit"> {slides ? '张' : '页'}</span></span>
      <button type="button" aria-label="Next page" title="下一页" disabled={page >= pages || !pages} onClick={() => onCommit(page + 1)}><ChevronRight size={15} /></button>
    </div>
    <div className="preview__reader-zoom">
      <button type="button" aria-label="Zoom out" title="缩小" disabled={!pages || scale <= .25} onClick={() => onZoom(1 / 1.2)}><Minus size={15} /></button>
      <span className="preview__page-label">{Math.round(scale * 100)}%</span>
      <button type="button" aria-label="Zoom in" title="放大" disabled={!pages || scale >= 4} onClick={() => onZoom(1.2)}><Plus size={15} /></button>
      <button type="button" aria-label="Fit width" title="适合宽度" disabled={!pages} onClick={() => onFit('page-width')}><Scan size={15} /></button>
      <button type="button" className="preview__fit-page" aria-label="Fit page" title="完整页面" disabled={!pages} onClick={() => onFit('page-fit')}>整页</button>
    </div>
  </footer>;
}

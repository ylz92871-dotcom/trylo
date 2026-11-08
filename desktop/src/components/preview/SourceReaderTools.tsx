import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Copy, CornerDownLeft, ListOrdered, LockKeyhole, Search, WrapText } from 'lucide-react';

export function useReaderNotice() {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice] as const;
}

export function SourceReaderTools({ children, lines, position, wrap, onWrap, onFind, onCopy, onGoTo, ready = true, notice = '', copyLabel = '复制全文' }: {
  children?: ReactNode; lines?: number; position?: { lineNumber: number; column: number };
  wrap: boolean; onWrap: () => void; onFind: () => void; onCopy: () => void;
  onGoTo?: (line: number) => void; ready?: boolean; notice?: string; copyLabel?: string;
}): ReactElement {
  const [goOpen, setGoOpen] = useState(false);
  const [line, setLine] = useState('1');
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!goOpen) return;
    input.current?.focus(); input.current?.select();
    const dismiss = (event: PointerEvent): void => { if (!popup.current?.contains(event.target as Node)) setGoOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [goOpen]);
  const go = (): void => {
    onGoTo?.(Math.max(1, Math.min(lines ?? 1, Math.trunc(Number(line)) || 1)));
    setGoOpen(false);
  };
  return <div className="source-reader__footer">
    {notice && <p className="source-reader__notice" role="status">{notice}</p>}
    <div className="source-reader__bar" role="toolbar" aria-label="阅读工具">
      <div className="source-reader__metadata"><LockKeyhole size={11} aria-label="只读" />{children}
        {lines !== undefined && <span>{lines.toLocaleString()} 行</span>}
        {position && <span className="source-reader__position">行 {position.lineNumber}，列 {position.column}</span>}
      </div>
      <div className="source-reader__actions">
        <button type="button" aria-label="自动换行" title="自动换行" aria-pressed={wrap} onClick={onWrap}><WrapText size={15} /></button>
        <button type="button" aria-label="查找" title="查找 · Ctrl+F" disabled={!ready} onClick={onFind}><Search size={15} /></button>
        {onGoTo && <div ref={popup} className="source-reader__goto-anchor">
          <button ref={trigger} type="button" aria-label="跳至行" title="跳至行" aria-expanded={goOpen} disabled={!ready}
            onClick={() => { setLine(String(position?.lineNumber ?? 1)); setGoOpen(!goOpen); }}><ListOrdered size={15} /></button>
          {goOpen && <form className="source-reader__goto" aria-label="跳至行" onSubmit={event => { event.preventDefault(); go(); }} onKeyDown={event => {
            if (event.key === 'Escape') { event.stopPropagation(); setGoOpen(false); trigger.current?.focus(); }
          }}>
            <label>跳至行 <span>1–{lines?.toLocaleString()}</span><input ref={input} type="number" aria-label="行号" value={line} onChange={event => setLine(event.target.value)} /></label>
            <button type="submit" aria-label="跳转"><CornerDownLeft size={15} /></button>
          </form>}
        </div>}
        <button type="button" aria-label={copyLabel} title={copyLabel} onClick={onCopy}><Copy size={14} /></button>
      </div>
    </div>
  </div>;
}

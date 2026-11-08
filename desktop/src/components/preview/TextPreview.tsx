import type { ReactElement, ReactNode } from 'react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { SourceReaderTools, useReaderNotice } from './SourceReaderTools';

export interface TextPreviewProps { readonly content: string }
const TextGutter = (): ReactElement => <div className="text-reader__gutter" aria-hidden="true" />;
const textComponents = { Header: TextGutter, Footer: TextGutter };
function highlight(line: string, query: string): ReactNode {
  if (!query) return line || ' ';
  const result: ReactNode[] = [];
  const lower = line.toLocaleLowerCase(), needle = query.toLocaleLowerCase();
  let start = 0, index = lower.indexOf(needle);
  while (index >= 0) {
    result.push(line.slice(start, index), <mark key={index}>{line.slice(index, index + query.length)}</mark>);
    start = index + query.length; index = lower.indexOf(needle, start);
  }
  result.push(line.slice(start));
  return result;
}
export function TextPreview({ content }: TextPreviewProps): ReactElement {
  const lines = useMemo(() => content.split('\n'), [content]);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [wrap, setWrap] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const [match, setMatch] = useState(0);
  const [notice, setNotice] = useReaderNotice();
  const input = useRef<HTMLInputElement>(null);
  const viewer = useRef<VirtuosoHandle>(null);
  const scroller = useRef<HTMLElement>();
  const matches = useMemo(() => {
    if (!deferredQuery) return [];
    const needle = deferredQuery.toLocaleLowerCase();
    return lines.flatMap((line, index) => line.toLocaleLowerCase().includes(needle) ? [index] : []);
  }, [lines, deferredQuery]);
  const current = matches[Math.min(match, Math.max(0, matches.length - 1))];
  useEffect(() => { setMatch(0); }, [deferredQuery]);
  useEffect(() => { if (current !== undefined) viewer.current?.scrollToIndex({ index: current, align: 'center' }); }, [current]);
  useEffect(() => { if (searchOpen) input.current?.focus(); }, [searchOpen]);
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(content); setNotice('已复制全文'); }
    catch { setNotice('无法访问剪贴板，请使用外部应用复制。'); }
  };
  const next = (direction: number): void => { if (matches.length) setMatch(value => (value + direction + matches.length) % matches.length); };
  return <div className={`source-reader text-reader${wrap ? ' text-reader--wrap' : ''}`} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true); input.current?.focus(); }
  }}>
    {searchOpen && <div className="source-reader__search" role="search" aria-label="文本查找">
      <input ref={input} type="search" aria-label="查找文本" placeholder="查找文本" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter') next(event.shiftKey ? -1 : 1);
        if (event.key === 'Escape') { event.stopPropagation(); setSearchOpen(false); setQuery(''); scroller.current?.focus({ preventScroll: true }); }
      }} />
      <span aria-live="polite">{current === undefined ? 0 : Math.min(match + 1, matches.length)} / {matches.length} 匹配行</span>
      <button type="button" aria-label="上一处" title="上一处" disabled={!matches.length} onClick={() => next(-1)}><ChevronUp size={14} /></button>
      <button type="button" aria-label="下一处" title="下一处" disabled={!matches.length} onClick={() => next(1)}><ChevronDown size={14} /></button>
      <button type="button" aria-label="关闭查找" title="关闭查找" onClick={() => { setSearchOpen(false); setQuery(''); scroller.current?.focus({ preventScroll: true }); }}><X size={14} /></button>
    </div>}
    <Virtuoso ref={viewer} components={textComponents} tabIndex={0} scrollerRef={element => { scroller.current = element instanceof HTMLElement ? element : undefined; }} className="preview__text-lines file-peek__code" style={{ flex: 1, minHeight: 0 }} data={lines} initialItemCount={30} defaultItemHeight={22}
      aria-label="File content" role="region" itemContent={(index, line) => <div className="file-peek__line" data-search-match={current === index ? 'true' : undefined}>
        <span className="file-peek__lineno">{index + 1}</span><span className="file-peek__linetext">{highlight(line, deferredQuery)}</span>
      </div>} />
    <SourceReaderTools lines={lines.length} wrap={wrap} onWrap={() => setWrap(value => !value)} onFind={() => { setSearchOpen(true); input.current?.focus(); }}
      onCopy={() => void copy()} onGoTo={line => { viewer.current?.scrollToIndex({ index: line - 1, align: 'start' }); scroller.current?.focus({ preventScroll: true }); }} notice={notice}><span>文本</span></SourceReaderTools>
  </div>;
}

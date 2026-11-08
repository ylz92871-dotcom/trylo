import { lazy, Suspense, useEffect, useMemo, useState, type ReactElement } from 'react';
import { loadArchivePreview } from '../../preview/providers/archive';
import type { ArchiveContents, ArchiveEntry as Entry } from '../../preview/providers/archive-types';
import { decodePreviewText } from '../../preview/decode-text';
import { sniffPreviewKind } from '../../preview/sniff';
import { usePreviewBytes } from './usePreviewBytes';
import { PreviewFailure } from './PreviewFailure';
import { CodePreview } from './CodePreview';
import { TextPreview } from './TextPreview';
import { MarkdownPreview } from './MarkdownPreview';
import { ImagePreview } from './ImagePreview';
import { CsvPreview } from './CsvPreview';
const NotebookPreview = lazy(() => import('./NotebookPreview').then((module) => ({ default: module.NotebookPreview })));
const PdfPreview = lazy(() => import('./PdfPreview').then((module) => ({ default: module.PdfPreview })));
function ArchiveEntry({ archive, entry }: { archive: ArchiveContents; entry: Entry }): ReactElement {
  const [loaded, setLoaded] = useState<{ bytes?: Uint8Array; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController(); setLoaded({});
    void archive.read(entry.id, controller.signal).then((bytes) => { if (!controller.signal.aborted) setLoaded({ bytes }); }, (error) => { if (!controller.signal.aborted) setLoaded({ error: String(error) }); });
    return () => controller.abort();
  }, [archive, entry]);
  const kind = loaded.bytes ? sniffPreviewKind(entry.name, loaded.bytes.subarray(0, 8192)) : 'text';
  if (loaded.error) return <PreviewFailure error={loaded.error} />;
  if (!loaded.bytes) return <p role="status" className="preview__reader-notice">正在读取归档条目…</p>;
  if (kind === 'pdf') return <Suspense fallback={<p role="status">正在读取 PDF…</p>}><PdfPreview path={entry.name} bytes={loaded.bytes} /></Suspense>;
  if (kind === 'image') return <ImagePreview path={entry.name} bytes={loaded.bytes} />;
  const text = ['text', 'code', 'markdown', 'csv', 'html', 'notebook', 'dxf', 'gerber'].includes(kind) ? decodePreviewText(loaded.bytes) : undefined;
  if (text !== undefined && !text.includes('\0')) {
    if (kind === 'markdown') return <MarkdownPreview content={text} />;
    if (kind === 'csv') return <CsvPreview path={entry.name} content={text} />;
    if (kind === 'notebook') return <Suspense fallback={<p role="status">正在读取笔记本…</p>}><NotebookPreview content={text} path={entry.name} /></Suspense>;
    if (kind === 'code') return <CodePreview path={entry.name} content={text} />;
    return <TextPreview content={text} />;
  }
  return <div className="preview__empty">此二进制条目暂不支持直接阅读。可使用外部应用打开原归档。</div>;
}
const size = (value: number) => value < 0 ? '大小未知' : value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
export function ArchivePreview({ path, allowedRoot }: { path: string; allowedRoot?: string }): ReactElement {
  const bytes = usePreviewBytes(path, undefined, allowedRoot);
  const [loaded, setLoaded] = useState<{ source?: Uint8Array; archive?: ArchiveContents; error?: string }>({});
  const [selected, setSelected] = useState<number>(); const [query, setQuery] = useState(''); const [page, setPage] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoaded({}); setSelected(undefined);
    if (bytes.status === 'ready') void loadArchivePreview(bytes.bytes, path, controller.signal).then((archive) => { if (!controller.signal.aborted) setLoaded({ source: bytes.bytes, archive }); }, (error) => { if (!controller.signal.aborted) setLoaded({ source: bytes.bytes, error: String(error) }); });
    return () => controller.abort();
  }, [bytes, path]);
  const currentSource = bytes.status === 'ready' && loaded.source === bytes.bytes;
  const archive = currentSource ? loaded.archive : undefined;
  const entries = archive?.entries ?? [];
  const filtered = useMemo(() => entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [entries, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / 200)); const current = Math.min(page, pages - 1);
  const entry = selected === undefined ? undefined : entries[selected];
  if (bytes.status === 'error' || (currentSource && loaded.error)) return <PreviewFailure error={currentSource && loaded.error ? loaded.error : bytes.status === 'error' ? bytes.message : ''} />;
  return <div className="preview__paged">
    <div className="preview__toolbar" role="toolbar" aria-label="归档阅读工具"><input type="search" aria-label="筛选归档路径" placeholder="筛选文件路径" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /><span>{filtered.length} / {entries.length} 项</span><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页目录</button><span>{current + 1} / {pages}</span><button type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>下一页目录</button>{entry && <button type="button" onClick={() => setSelected(undefined)}>返回目录</button>}</div>
    {!archive ? <p role="status" className="preview__reader-notice">正在读取归档目录…</p> : entry ? <><div className="preview__reader-notice">{entry.name} · {size(entry.size)}</div><ArchiveEntry key={entry.id} archive={archive} entry={entry} /></> : <div className="preview__archive-directory"><table><caption>归档内容 · 只读，不解压到项目</caption><thead><tr><th scope="col">路径</th><th scope="col">大小</th></tr></thead><tbody>{filtered.slice(current * 200, current * 200 + 200).map((entry) => <tr key={entry.id}><td>{entry.directory || entry.readable === false ? entry.name + (entry.directory ? "" : " · 链接或特殊条目") : <button type="button" onClick={() => setSelected(entry.id)}>{entry.name}{entry.encrypted ? ' · 已加密' : ''}</button>}</td><td>{entry.directory ? '—' : size(entry.size)}</td></tr>)}</tbody></table>{!filtered.length && <p className="preview__empty">{entries.length ? '没有匹配的路径' : '归档目录为空'}</p>}</div>}
  </div>;
}

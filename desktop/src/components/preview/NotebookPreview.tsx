import { lazy, Suspense, useEffect, useMemo, useState, type ReactElement } from 'react';
import { notebookStaticHtml, notebookText, parseNotebook, type NotebookOutput } from '../../preview/providers/notebook';
import { SOURCE_LANGUAGES } from '../../preview/languages';
import { CodePreview } from './CodePreview';
import { MarkdownPreview, type MarkdownPreviewProps } from './MarkdownPreview';
import { TextPreview } from './TextPreview';
const PdfPreview = lazy(() => import('./PdfPreview').then((module) => ({ default: module.PdfPreview })));

function NotebookImage({ mime, value }: { mime: string; value: string }): ReactElement {
  const [url, setUrl] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    let resource = '';
    try {
      if (value.length > 12 * 1024 * 1024) throw new Error('此图像输出超过 12 MB，请使用外部应用查看');
      const bytes = mime === 'image/svg+xml' ? value : Uint8Array.from(atob(value.replace(/\s/g, '')), (char) => char.charCodeAt(0));
      resource = URL.createObjectURL(new Blob([bytes], { type: mime })); setUrl(resource); setError('');
    } catch (error) { setError(String(error)); }
    return () => { if (resource) URL.revokeObjectURL(resource); };
  }, [mime, value]);
  return error ? <p role="alert">{error}</p> : <img className="preview__notebook-image" src={url || undefined} alt="笔记本保存的图像输出" onError={() => setError('图像输出无法解码')} />;
}
function NotebookSavedOutput({ output }: { output: NotebookOutput }): ReactElement {
  const [source, setSource] = useState(false);
  const data = output.data ?? {};
  const pdf = useMemo(() => {
    const encoded = notebookText(data['application/pdf']);
    if (!encoded || encoded.length > 12 * 1024 * 1024) return undefined;
    try { return Uint8Array.from(atob(encoded.replace(/\s/g, '')), (char) => char.charCodeAt(0)); } catch { return undefined; }
  }, [data]);
  if (output.kind === 'text') return <pre className="preview__notebook-output">{(output.text ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')}</pre>;
  for (const mime of ['image/png', 'image/jpeg', 'image/svg+xml', 'image/gif', 'image/webp']) {
    const value = notebookText(data[mime]); if (value) return <NotebookImage mime={mime} value={value} />;
  }
  if (pdf) return <div className="preview__notebook-reader"><Suspense fallback={<p role="status">正在读取 PDF 输出…</p>}><PdfPreview path="notebook-output.pdf" bytes={pdf} /></Suspense></div>;
  const html = notebookText(data['text/html']);
  if (html) return <div><div className="preview__toolbar"><button type="button" aria-pressed={source} onClick={() => setSource((value) => !value)}>输出源码</button></div>{source ? <pre className="preview__notebook-output">{html}</pre> : <iframe title="笔记本保存的 HTML 输出" sandbox="" className="preview__notebook-html" srcDoc={notebookStaticHtml(html)} />}</div>;
  const markdown = notebookText(data['text/markdown']); if (markdown) return <MarkdownPreview content={markdown} />;
  const text = notebookText(data['text/plain']) || (data['application/json'] !== undefined ? JSON.stringify(data['application/json'], null, 2) : '此输出需要原始笔记本环境；请查看源码或使用外部应用。');
  return <pre className="preview__notebook-output">{text}</pre>;
}
function SavedOutputs({ outputs }: { outputs: readonly NotebookOutput[] }): ReactElement | null {
  const [index, setIndex] = useState(0);
  if (!outputs.length) return null;
  const current = Math.min(index, outputs.length - 1);
  return <div className="preview__notebook-outputs">
    {outputs.length > 1 && <div className="preview__toolbar" role="toolbar" aria-label="单元输出切换"><button type="button" disabled={current === 0} onClick={() => setIndex(current - 1)}>上一项输出</button><span>{current + 1} / {outputs.length} 项输出</span><button type="button" disabled={current === outputs.length - 1} onClick={() => setIndex(current + 1)}>下一项输出</button></div>}
    <NotebookSavedOutput key={current} output={outputs[current]!} />
  </div>;
}
export function NotebookPreview(props: MarkdownPreviewProps & { content: string }): ReactElement {
  const parsed = useMemo(() => { try { return { notebook: parseNotebook(props.content), error: '' }; } catch (error) { return { notebook: undefined, error: String(error) }; } }, [props.content]);
  const [source, setSource] = useState(false); const [page, setPage] = useState(0); const [query, setQuery] = useState(''); const [highlight, setHighlight] = useState(-1);
  const cells = parsed.notebook?.cells ?? [];
  const matches = useMemo(() => cells.flatMap((cell, index) => !query || `${cell.source}\n${cell.outputs.map((output) => output.text ?? notebookText(output.data?.['text/plain'])).join('\n')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? [index] : []), [cells, query]);
  const pages = Math.max(1, Math.ceil(matches.length / 10)); const current = Math.min(page, pages - 1);
  const language = parsed.notebook?.language.toLowerCase() ?? 'python';
  const codeExtension = SOURCE_LANGUAGES.find((item) => item.id === language || item.label.toLowerCase() === language)?.extensions[0] ?? '.txt';
  return <div className="preview__paged">
    <div className="preview__toolbar" role="toolbar" aria-label="笔记本阅读工具">
      <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>笔记本</button><button type="button" aria-pressed={source} onClick={() => setSource(true)}>源码</button>
      {!source && <><input type="search" aria-label="查找笔记本单元" placeholder="查找单元或文本输出" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>上一组单元</button><span>{matches.length} 个单元 · {current + 1} / {pages}</span><button type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>下一组单元</button><label>跳至单元 <input aria-label="跳至笔记本单元" type="number" min={1} max={cells.length} onChange={(event) => { const index = Number(event.target.value) - 1; if (Number.isInteger(index) && index >= 0 && index < cells.length) { setQuery(''); setPage(Math.floor(index / 10)); } }} /></label><span>保存的内容 · 只读</span></>}
    </div>
    {source ? <TextPreview content={props.content} /> : parsed.error ? <div className="preview__empty" role="alert">{parsed.error}</div> : <div className="preview__notebook" role="region" aria-label="笔记本保存内容">
      {!matches.length && <p className="preview__empty">{cells.length ? '没有匹配的单元' : '此笔记本还没有单元'}</p>}
      {matches.slice(current * 10, current * 10 + 10).map((index) => {
        const cell = cells[index]!;
        return <section className="preview__notebook-cell" key={index} aria-label={`单元 ${index + 1}`}>
          <div className="preview__notebook-cell-meta"><span>{index + 1} · {cell.kind === 'code' ? `In [${cell.execution ?? ' '}]` : cell.kind === 'markdown' ? 'Markdown' : 'Raw'}</span>{cell.kind === 'code' && <button type="button" aria-pressed={highlight === index} onClick={() => setHighlight(highlight === index ? -1 : index)}>高亮阅读</button>}</div>
          {cell.kind === 'markdown' ? <MarkdownPreview {...props} content={cell.source} /> : highlight === index ? <div className="preview__notebook-reader"><CodePreview path={`cell-${index}${codeExtension}`} content={cell.source} /></div> : <pre className="preview__notebook-source">{cell.source}</pre>}
          <SavedOutputs outputs={cell.outputs} />
        </section>;
      })}
    </div>}
  </div>;
}

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { prepareHtml } from './htmlResources';
import { InteractiveWebPreview } from './InteractiveWebPreview';
import { LazyCodePreview } from './LazyCodePreview';

export interface HtmlPreviewProps { readonly content: string; readonly title: string; readonly allowedRoot?: string }
function StaticHtmlPreview(props: HtmlPreviewProps): ReactElement {
  const [prepared, setPrepared] = useState<{ html: string; warnings: readonly string[] }>();
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    if (!props.allowedRoot) { setPrepared({ html: props.content, warnings: [] }); return; }
    void prepareHtml(props.content, props.title, props.allowedRoot, abort.signal).then(
      (result) => { if (!abort.signal.aborted) setPrepared(result); },
      (reason: unknown) => { if (!abort.signal.aborted) setError(String(reason)); },
    );
    return () => abort.abort();
  }, [props.content, props.title, props.allowedRoot]);
  if (error) return <div className="preview__empty" role="alert">无法读取网页资源：{error}</div>;
  if (!prepared) return <div className="preview__empty" role="status">正在读取网页和资源…</div>;
  return <div className="preview__paged">
    {!!prepared.warnings.length && <p className="preview__web-status">{prepared.warnings.length} 个资源未载入</p>}
    <iframe className="preview__html" title="静态网页预览" sandbox="" srcDoc={prepared.html} />
  </div>;
}
export function HtmlPreview(props: HtmlPreviewProps): ReactElement {
  const [mode, setMode] = useState<'interactive' | 'static' | 'source'>('interactive');
  return <div className="preview__paged">
    <div className="preview__toolbar" role="toolbar" aria-label="网页视图">
      <button type="button" aria-pressed={mode === 'interactive'} onClick={() => setMode('interactive')}>交互预览</button>
      <button type="button" aria-pressed={mode === 'static'} onClick={() => setMode('static')}>静态预览</button>
      <button type="button" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>源码</button>
    </div>
    {mode === 'interactive' ? <InteractiveWebPreview path={props.title} allowedRoot={props.allowedRoot} onStatic={() => setMode('static')} />
      : mode === 'source' ? <LazyCodePreview path={props.title} content={props.content} /> : <StaticHtmlPreview {...props} />}
  </div>;
}

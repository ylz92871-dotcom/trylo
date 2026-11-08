import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, Scan } from 'lucide-react';
import { renderAsync } from 'docx-preview';
import { usePreviewBytes } from './usePreviewBytes';
import { PreviewFailure } from './PreviewFailure';

export interface DocxPreviewProps { readonly path: string; readonly allowedRoot?: string }
/** Reflowed reading keeps authored content; paginated Office view owns fidelity. */
export function DocxPreview({ path, allowedRoot }: DocxPreviewProps): ReactElement {
  const state = usePreviewBytes(path, undefined, allowedRoot);
  const bytes = state.status === 'ready' ? state.bytes : undefined;
  const paper = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0), [zoom, setZoom] = useState(1);
  useEffect(() => { setZoom(1); }, [path, allowedRoot]);
  useEffect(() => {
    const container = paper.current;
    if (!bytes || !container) return;
    let cancelled = false;
    setStatus('loading'); setError(''); container.replaceChildren();
    const content = document.createElement('div');
    const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    void renderAsync(blob, content, undefined, {
      className: 'trylo-docx', inWrapper: false, ignoreWidth: true, ignoreHeight: true,
      breakPages: false, useBase64URL: true,
    }).then(() => {
      if (!cancelled) { container.replaceChildren(content); setStatus('ready'); }
    }).catch((cause: unknown) => {
      if (!cancelled) { setError(cause instanceof Error ? cause.message : String(cause)); setStatus('error'); }
    });
    // Embedded resources are data URLs, owned by this detached DOM tree.
    return () => { cancelled = true; container.replaceChildren(); content.replaceChildren(); };
  }, [bytes, path, allowedRoot, revision]);
  const failure = state.status === 'error' ? state.message : status === 'error' ? error : '';
  const loading = state.status === 'loading' || status === 'loading';
  return <div className="docx-reader preview__paged" role="region" aria-label="Word preview">
    <div className="docx-reader__stage">
      <div className="docx-reader__viewport" hidden={!!failure || loading}>
        <div ref={paper} className="docx-reader__paper" style={{ zoom }} />
      </div>
      {!failure && loading && <div className="docx-reader__state" role="status"><span className="preview__spinner" /><strong>正在排版文档…</strong><span>正在读取文字、图片与表格</span></div>}
      {failure && <div className="docx-reader__state"><PreviewFailure error={failure}>
        {state.status !== 'error' ? <button type="button" onClick={() => setRevision(value => value + 1)}>重试排版</button> : <p>请使用顶部的重新加载再次读取文件。</p>}
      </PreviewFailure></div>}
    </div>
    <footer className="preview__reader-status" aria-label="文档阅读控制"><span>连续阅读</span><div className="preview__reader-zoom">
      <button type="button" aria-label="缩小文档" disabled={loading || !!failure || zoom <= .5} onClick={() => setZoom(value => Math.max(.5, Math.round((value - .1) * 10) / 10))}><Minus size={15} /></button>
      <span className="preview__page-label">{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="放大文档" disabled={loading || !!failure || zoom >= 2} onClick={() => setZoom(value => Math.min(2, Math.round((value + .1) * 10) / 10))}><Plus size={15} /></button>
      <button type="button" aria-label="适合阅读宽度" title="适合阅读宽度" disabled={loading || !!failure} onClick={() => setZoom(1)}><Scan size={15} /></button>
    </div></footer>
  </div>;
}

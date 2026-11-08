import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { invalidateOfficePages, loadOfficePages } from '../../host-adapter/preview/office-pages';
import { PdfPreview } from './PdfPreview';
import { DocxPreview } from './DocxPreview';
import { XlsxPreview } from './XlsxPreview';
import { PptxPreview } from './PptxPreview';
import { PreviewFailure } from './PreviewFailure';

export function OfficePreview({ path, allowedRoot, kind }: {
  path: string; allowedRoot?: string; kind: 'docx' | 'xlsx' | 'pptx' | 'office';
}): ReactElement {
  const [mode, setMode] = useState<'pages' | 'basic'>('pages');
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ bytes?: Uint8Array; error?: string }>({});
  useEffect(() => {
    if (mode !== 'pages') return;
    let cancelled = false;
    const abort = new AbortController();
    setResult({});
    if (!allowedRoot) { setResult({ error: '请先打开文件所在的项目目录。' }); return; }
    void loadOfficePages(path, allowedRoot, abort.signal).then(
      (bytes) => { if (!cancelled) setResult({ bytes }); },
      (error: unknown) => { if (!cancelled) setResult({ error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { cancelled = true; abort.abort(); };
  }, [path, allowedRoot, mode, revision]);
  const views = <div className="preview__office-views" role="group" aria-label="Office view">
    <button type="button" aria-pressed={mode === 'pages'} onClick={() => setMode('pages')}>{kind === 'pptx' ? '幻灯片' : '页面'}</button>
    {kind !== 'office' && <button type="button" aria-pressed={mode === 'basic'} onClick={() => setMode('basic')}>{kind === 'xlsx' ? '数据' : kind === 'docx' ? '阅读' : '基础预览'}</button>}
  </div>;
  const note = mode === 'pages' ? '只读页面 · 排版可能因字体与兼容性存在差异' : kind === 'xlsx' ? '仅单元格数据，不含图表与图片' : kind === 'docx' ? '阅读视图会重排内容；查看原始分页请切换页面' : '简化排版，完整内容请使用页面预览';
  return <div className="preview__paged preview__office" aria-label="Office preview">
    {mode === 'pages' && result.bytes ? <PdfPreview path={path} bytes={result.bytes} presentation={kind === 'pptx' ? 'slides' : 'document'} toolbarStart={views} initialScale={kind === 'docx' || kind === 'office' ? 'auto' : 'page-width'} /> : <>
      <div className="preview__reader-toolbar">{views}</div>
      {mode === 'pages' ? result.error ? <PreviewFailure error={result.error}><p><button type="button" onClick={() => { if (allowedRoot) invalidateOfficePages(path, allowedRoot); setRevision((n) => n + 1); }}>重试页面预览</button>{kind !== 'office' && <> <button type="button" onClick={() => setMode('basic')}>{kind === 'xlsx' ? '查看单元格数据' : '切换基础预览'}</button></>}</p></PreviewFailure>
        : <div className="preview__converting" role="status"><span className="preview__spinner" /><strong>正在准备{kind === 'pptx' ? '幻灯片' : '页面'}</strong><span>首次打开需要转换，请稍候</span></div>
        : kind === 'docx' ? <DocxPreview path={path} allowedRoot={allowedRoot} /> : kind === 'xlsx' ? <XlsxPreview path={path} allowedRoot={allowedRoot} /> : <PptxPreview path={path} allowedRoot={allowedRoot} />}
    </>}
    <div className="preview__office-note" title={note}>{note}</div>
  </div>;
}

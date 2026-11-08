// PDF.js owns the render queue, high-DPI pages and selectable text.
// Office page previews reuse this reader with supplied PDF bytes.
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, PanelLeft, RotateCw, Search } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PdfThumbnails } from './PdfThumbnails';
import { PdfReaderControls } from './PdfReaderControls';
import { getDocument, GlobalWorkerOptions, PasswordResponses } from 'pdfjs-dist';
import { EventBus, PDFViewer, PDFSinglePageViewer, PDFLinkService, PDFFindController } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { usePreviewBytes } from './usePreviewBytes';
import { PreviewFailure } from './PreviewFailure';

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
export interface PdfPreviewProps { readonly path: string; readonly bytes?: Uint8Array; readonly allowedRoot?: string; readonly presentation?: 'document' | 'slides'; readonly toolbarStart?: ReactNode; readonly initialScale?: 'auto' | 'page-width' }

export function PdfPreview({ path, bytes, allowedRoot, presentation = 'document', toolbarStart, initialScale = 'page-width' }: PdfPreviewProps): ReactElement {
  const slides = presentation === 'slides';
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy>();
  const [thumbnails, setThumbnails] = useState(slides);
  const state = usePreviewBytes(path, bytes, allowedRoot);
  const readyBytes = state.status === 'ready' ? state.bytes : undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer>();
  const busRef = useRef<EventBus>();
  const searchRef = useRef<HTMLInputElement>(null);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [scale, setScale] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState({ current: 0, total: 0 });
  const [passwordNeeded, setPasswordNeeded] = useState<{ incorrect: boolean }>();
  const [password, setPassword] = useState('');
  const unlock = useRef<{ submit: (password: string) => void; cancel: () => void }>();

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !readyBytes) return;
    const abort = new AbortController();
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    // Keep internal destinations without letting document links navigate
    // the application shell. Scripting and form editing are not enabled.
    linkService.externalLinkEnabled = false;
    const findController = new PDFFindController({ eventBus, linkService });
    const viewerElement = document.createElement('div');
    viewerElement.className = 'pdfViewer';
    container.replaceChildren(viewerElement);
    // v6 runtime supports abortSignal; its published declaration omits it.
    const viewerOptions = {
      container, viewer: viewerElement, eventBus, linkService, findController,
      annotationMode: 1, textLayerMode: 1, annotationEditorMode: -1,
      abortSignal: abort.signal,
    };
    const viewer = slides ? new PDFSinglePageViewer(viewerOptions) : new PDFViewer(viewerOptions);
    linkService.setViewer(viewer);
    viewerRef.current = viewer; busRef.current = eventBus;
    setPdfDocument(undefined); setPages(0); setPage(1); setPageInput('1'); setQuery('');
    setMatches({ current: 0, total: 0 }); setError(''); setLoading(true);
    setPasswordNeeded(undefined); setPassword('');
    const task = getDocument({
      data: readyBytes.slice(),
      cMapUrl: new URL('/pdf-assets/cmaps/', document.baseURI).href, cMapPacked: true,
      standardFontDataUrl: new URL('/pdf-assets/standard_fonts/', document.baseURI).href,
      wasmUrl: new URL('/pdf-assets/wasm/', document.baseURI).href,
    });
    let passwordCancelled = false;
    task.onPassword = (submit: (password: string) => void, reason: number): void => {
      if (abort.signal.aborted || passwordCancelled) return;
      unlock.current = { submit, cancel: () => { passwordCancelled = true; void task.destroy().catch(() => undefined); setPasswordNeeded(undefined); setLoading(false); setError('已取消解锁，请重载文件或使用外部应用打开。'); } };
      setPasswordNeeded({ incorrect: reason === PasswordResponses.INCORRECT_PASSWORD });
    };
    eventBus.on('pagesinit', () => {
      if (abort.signal.aborted) return;
      viewer.currentScaleValue = slides ? 'page-fit' : initialScale; setLoading(false);
    });
    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      if (abort.signal.aborted) return;
      setPage(pageNumber); setPageInput(String(pageNumber));
    });
    eventBus.on('scalechanging', ({ scale: next }: { scale: number }) => {
      if (!abort.signal.aborted) setScale(next);
    });
    eventBus.on('pagerendered', ({ error: renderError }: { error?: unknown }) => {
      if (renderError && !abort.signal.aborted) setError(String(renderError));
    });
    eventBus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
      if (!abort.signal.aborted) setMatches(matchesCount);
    });
    eventBus.on('updatefindcontrolstate', ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
      if (!abort.signal.aborted && matchesCount) setMatches(matchesCount);
    });
    void task.promise.then((doc) => {
      if (abort.signal.aborted) return;
      setPdfDocument(doc); setPages(doc.numPages); linkService.setDocument(doc); viewer.setDocument(doc);
    }).catch((err: unknown) => {
      if (!abort.signal.aborted && !passwordCancelled) { setError(String(err)); setLoading(false); }
    });
    const observer = new ResizeObserver(() => {
      const fit = viewer.currentScaleValue;
      if (fit === 'page-width' || fit === 'page-fit' || fit === 'auto') viewer.currentScaleValue = fit;
    });
    observer.observe(container);
    return () => {
      abort.abort(); observer.disconnect(); viewer.cleanup();
      unlock.current = undefined;
      viewerRef.current = undefined; busRef.current = undefined;
      void task.destroy().catch(() => undefined); container.replaceChildren();
    };
  }, [readyBytes, slides, initialScale]);

  const go = (next: number): void => {
    if (viewerRef.current && pages) {
      const number = Math.max(1, Math.min(pages, Math.trunc(next)));
      viewerRef.current.currentPageNumber = number; setPageInput(String(number));
    }
  };
  const find = (value: string, previous = false, again = false): void => {
    if (!value) setMatches({ current: 0, total: 0 });
    busRef.current?.dispatch('find', {
      source: searchRef.current, type: again ? 'again' : '', query: value,
      caseSensitive: false, entireWord: false, highlightAll: true,
      findPrevious: previous, matchDiacritics: false,
    });
  };
  const zoom = (factor: number): void => {
    const viewer = viewerRef.current;
    if (viewer) viewer.currentScale = Math.max(0.25, Math.min(4, viewer.currentScale * factor));
  };
  const loadError = state.status === 'error' ? state.message : error;
  return <div className={`preview__paged preview__pdf${slides ? ' preview__pdf--slides' : ''}`} role="region" tabIndex={slides ? 0 : undefined} onKeyDown={event => {
      if (!slides || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).matches('input,select,textarea')) return;
      const next = event.key === 'ArrowRight' || event.key === 'PageDown' ? page + 1 : event.key === 'ArrowLeft' || event.key === 'PageUp' ? page - 1 : event.key === 'Home' ? 1 : event.key === 'End' ? pages : undefined;
      if (next !== undefined) { event.preventDefault(); go(next); }
    }} aria-label={slides ? 'Presentation preview' : 'PDF preview'}>
    <div className="preview__reader-toolbar" role="toolbar" aria-label="PDF controls">
      <button type="button" aria-label="页面缩略图" title="页面缩略图" aria-expanded={thumbnails} disabled={!pages} onClick={() => setThumbnails(!thumbnails)}><PanelLeft size={16} /></button>
      {toolbarStart ?? <span className="preview__reader-mode">文档</span>}
      <span className="preview__toolbar-spacer" />
      <button type="button" aria-label="Rotate clockwise" title="顺时针旋转" disabled={!pages} onClick={() => { if (viewerRef.current) viewerRef.current.pagesRotation = (viewerRef.current.pagesRotation + 90) % 360; }}><RotateCw size={15} /></button>
      <button type="button" aria-label="Search PDF" title="搜索文档" aria-expanded={searchOpen} disabled={!pages} onClick={() => { setSearchOpen(!searchOpen); requestAnimationFrame(() => searchRef.current?.focus()); }}><Search size={15} /></button>
    </div>
    {searchOpen && <div className="preview__toolbar preview__search">
      <input ref={searchRef} aria-label="Search text" placeholder="搜索文档" value={query} onChange={(e) => { setQuery(e.target.value); find(e.target.value); }} onKeyDown={(e) => {
        if (e.key === 'Enter') find(query, e.shiftKey, true);
        if (e.key === 'Escape') { e.stopPropagation(); setSearchOpen(false); }
      }} />
      <span aria-live="polite">{matches.current} / {matches.total}</span>
      <button type="button" aria-label="Previous match" disabled={!query} onClick={() => find(query, true, true)}><ChevronLeft size={15} /></button>
      <button type="button" aria-label="Next match" disabled={!query} onClick={() => find(query, false, true)}><ChevronRight size={15} /></button>
    </div>}
    {loadError && <PreviewFailure error={loadError}><p>请重试或使用外部应用打开。</p></PreviewFailure>}
    {passwordNeeded && <form className="preview__password" onSubmit={(event) => { event.preventDefault(); unlock.current?.submit(password); setPassword(''); setPasswordNeeded(undefined); }}>
      <label htmlFor="preview-pdf-password">{passwordNeeded.incorrect ? '密码不正确，请重试' : '这份 PDF 需要密码'}</label>
      <input id="preview-pdf-password" aria-label="PDF 密码" type="password" autoComplete="off" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
      <button type="submit" disabled={!password}>解锁预览</button>
      <button type="button" onClick={() => { setPassword(''); unlock.current?.cancel(); }}>取消</button>
    </form>}
    <div className="preview__reader-body" hidden={!!loadError || !!passwordNeeded}>
      {thumbnails && pdfDocument && <PdfThumbnails key={pdfDocument.fingerprints[0]} document={pdfDocument} page={page} onSelect={go} />}
      <div className="preview__pdf-stage">
        {!passwordNeeded && (loading || state.status === 'loading') && <div className="preview__loading" role="status"><span className="preview__spinner" />正在加载文档…</div>}
        <div ref={containerRef} className="preview__pdf-container" />
      </div>
    </div>
    <PdfReaderControls page={page} pages={pages} pageInput={pageInput} onPageInput={setPageInput} onCommit={go}
      scale={scale} onZoom={zoom} slides={slides} onFit={value => { if (viewerRef.current) viewerRef.current.currentScaleValue = value; }} />
  </div>;
}

// Trylo Desktop — PdfPreview (base capability).
//
// PDF.js (Mozilla, Apache-2.0) straight on canvas: one page at a time,
// prev/next + zoom. The worker URL is bundled by Vite — the assignment
// MUST stay a single-line `new URL(...)` (Vite ≥7.1 misses multiline
// forms and the viewer silently falls back to the fake worker).
//
// Test note: PDF.js needs canvas + worker, neither exists in jsdom, so
// this component is typechecked + manually verified, not unit-tested.
// Routing is covered in previewKind.test.ts.

import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import { usePreviewBytes } from './usePreviewBytes';

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

export interface PdfPreviewProps {
  readonly path: string;
}

export function PdfPreview(props: PdfPreviewProps): ReactElement {
  const bytesState = usePreviewBytes(props.path);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  // v6 lifecycle: teardown owns the LOADING TASK (doc has no destroy).
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState('');

  // Load the document. A fresh copy of the bytes goes in — PDF.js may
  // detach (transfer) the buffer it is given, and the hook's copy must
  // stay intact for a reload.
  useEffect(() => {
    if (bytesState.status !== 'ready') return undefined;
    let cancelled = false;
    setError('');
    setNumPages(0);
    setPageNum(1);
    // Clear the previous document's pixels while the new one loads.
    if (canvasRef.current) canvasRef.current.width = 0;
    // Tear down the previous load before starting the next one.
    const prev = taskRef.current;
    taskRef.current = null;
    docRef.current = null;
    if (prev) void prev.destroy().catch(() => undefined);
    const loadingTask = getDocument({ data: bytesState.bytes.slice() });
    taskRef.current = loadingTask;
    loadingTask.promise.then(
      (doc) => {
        if (cancelled || taskRef.current !== loadingTask) {
          void loadingTask.destroy().catch(() => undefined);
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
      if (taskRef.current === loadingTask) {
        taskRef.current = null;
        docRef.current = null;
        void loadingTask.destroy().catch(() => undefined);
      }
    };
  }, [bytesState]);

  // Render the current page. The previous render is cancelled first so
  // fast page-flipping can't land a stale page on the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    const doc = docRef.current;
    if (!canvas || !doc || numPages === 0) return undefined;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | undefined;
    void doc.getPage(pageNum).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // v6 render takes the canvas element (context is derived).
      renderTask = page.render({ canvas, viewport });
      renderTask.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pageNum, scale, numPages, props.path]);

  const goPage = useCallback(
    (next: number): void => {
      setPageNum(Math.min(Math.max(1, next), Math.max(1, numPages)));
    },
    [numPages],
  );

  if (bytesState.status === 'loading') {
    return <div className="preview__empty">Loading PDF…</div>;
  }
  if (bytesState.status === 'error') {
    return <div className="preview__empty">Could not load PDF: {bytesState.message}</div>;
  }
  if (error !== '') {
    return <div className="preview__empty">Could not render PDF: {error}</div>;
  }

  return (
    <div className="preview__paged" role="region" aria-label="PDF preview">
      <div className="preview__toolbar">
        <button type="button" onClick={() => goPage(pageNum - 1)} disabled={pageNum <= 1} aria-label="Previous page">‹</button>
        <span className="preview__page-label">{pageNum} / {numPages === 0 ? '…' : numPages}</span>
        <button type="button" onClick={() => goPage(pageNum + 1)} disabled={pageNum >= numPages} aria-label="Next page">›</button>
        <span className="preview__sep" aria-hidden="true">·</span>
        <button type="button" onClick={() => setScale((s) => Math.max(MIN_SCALE, s - 0.25))} disabled={scale <= MIN_SCALE} aria-label="Zoom out">−</button>
        <span className="preview__page-label">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => setScale((s) => Math.min(MAX_SCALE, s + 0.25))} disabled={scale >= MAX_SCALE} aria-label="Zoom in">+</button>
      </div>
      <div className="preview__canvas-wrap">
        <canvas ref={canvasRef} className="preview__canvas" />
      </div>
    </div>
  );
}

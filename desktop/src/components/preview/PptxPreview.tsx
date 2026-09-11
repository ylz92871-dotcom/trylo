// Trylo Desktop — PptxPreview (base capability).
//
// pptxviewjs (MIT) renders OOXML slides onto canvas. Two hard-won
// facts about this library version (verified in source + E2E):
//   1. `renderSlide` silently DROPS the options bag (processor takes
//      only canvas+index) — so `scale`/`quality` params are theater.
//      Do NOT pass them; do NOT build UI on them.
//   2. The slide is fit into the canvas's LOGICAL size (inline CSS
//      w/h when set, else backing/dpr). So fit-width and zoom both
//      work by sizing the canvas element, then rendering plain.
//
// Modes: paged (one slide + prev/next) and continuous (all slides in
// one scrolling column; clicking a slide dives into paged view).
// Rail resizes re-render via ResizeObserver (debounced).
//
// jsdom has no canvas, so this is typechecked + E2E-verified;
// routing is covered in previewKind.test.ts.

import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PPTXViewer } from 'pptxviewjs';
import { usePreviewBytes } from './usePreviewBytes';

type SlideMode = 'paged' | 'all';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const FALLBACK_ASPECT = 16 / 9;
const REFIT_DEBOUNCE_MS = 150;

export interface PptxPreviewProps {
  readonly path: string;
}

export function PptxPreview(props: PptxPreviewProps): ReactElement {
  const bytesState = usePreviewBytes(props.path);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<PPTXViewer | null>(null);
  const slideCanvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const renderToken = useRef(0);
  const refitTimer = useRef<number | undefined>(undefined);
  const [slideCount, setSlideCount] = useState(0);
  const [slideIndex, setSlideIndex] = useState(0);
  const [mode, setMode] = useState<SlideMode>('paged');
  const [zoom, setZoom] = useState(1);
  const [wrapWidth, setWrapWidth] = useState(0);
  const [error, setError] = useState('');

  // Load once per file. destroy() exists on the viewer — a new file
  // gets a fresh viewer and the old one is torn down properly.
  useEffect(() => {
    if (bytesState.status !== 'ready') return undefined;
    let cancelled = false;
    setError('');
    setSlideCount(0);
    setSlideIndex(0);
    setZoom(1);
    setMode('paged');
    const viewer = new PPTXViewer();
    viewerRef.current = viewer;
    // A copy: loaders may detach the buffer they are given.
    viewer.loadFile(bytesState.bytes.slice()).then(
      () => {
        if (cancelled) {
          viewer.destroy();
          return;
        }
        setSlideCount(viewer.getSlideCount());
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
      if (viewerRef.current === viewer) viewerRef.current = null;
      viewer.destroy();
    };
  }, [bytesState]);

  // Track the rail width so renders stay fit on resize.
  //
  // NOTE: this MUST re-run when the byte state settles. On first mount
  // the component renders the loading placeholder (no wrap div yet); a
  // mount-only effect would measure null once, never observe, and pin
  // wrapWidth at 0 forever — silently disabling every render.
  useEffect(() => {
    if (bytesState.status !== 'ready') return undefined;
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    setWrapWidth(wrap.clientWidth);
    const observer = new ResizeObserver(() => {
      window.clearTimeout(refitTimer.current);
      refitTimer.current = window.setTimeout(() => {
        if (wrapRef.current) setWrapWidth(wrapRef.current.clientWidth);
      }, REFIT_DEBOUNCE_MS);
    });
    observer.observe(wrap);
    return () => {
      window.clearTimeout(refitTimer.current);
      observer.disconnect();
    };
  }, [bytesState]);

  // Render one slide. Sizing IS the zoom: the library fits the slide
  // into the canvas's logical (CSS) size, so fit-width = rail width
  // and zoom-in = a wider logical canvas + scroll to pan. At zoom 1
  // the inline size is cleared and the stylesheet (width:100%) rules.
  const renderOne = useCallback(
    async (
      viewer: PPTXViewer,
      index: number,
      canvas: HTMLCanvasElement,
      railWidth: number,
      zoomLevel: number,
    ): Promise<void> => {
      if (zoomLevel === 1) {
        canvas.style.width = '';
        canvas.style.height = '';
      } else {
        const ratio =
          canvas.width > 0 && canvas.height > 0
            ? canvas.width / canvas.height
            : FALLBACK_ASPECT;
        const logicalWidth = Math.max(1, Math.round(railWidth * zoomLevel));
        canvas.style.width = `${logicalWidth}px`;
        canvas.style.height = `${Math.max(1, Math.round(logicalWidth / ratio))}px`;
      }
      await viewer.renderSlide(index, canvas);
    },
    [],
  );

  // (Re)render on slide / mode / zoom / width change. Stale passes
  // (fast flipping, file switch) are dropped by token. Continuous
  // mode paints slides sequentially — later slides never jump ahead
  // of an in-flight earlier one.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || slideCount === 0 || wrapWidth <= 0) return undefined;
    let cancelled = false;
    const token = (renderToken.current += 1);
    const isCurrent = (): boolean => !cancelled && renderToken.current === token;
    const fail = (err: unknown): void => {
      if (isCurrent()) setError(err instanceof Error ? err.message : String(err));
    };
    if (mode === 'paged') {
      const canvas = canvasRef.current;
      if (!canvas) return undefined;
      void renderOne(viewer, slideIndex, canvas, wrapWidth, zoom).catch(fail);
    } else {
      void (async (): Promise<void> => {
        for (let i = 0; i < slideCount; i += 1) {
          if (!isCurrent()) return;
          const canvas = slideCanvasRefs.current.get(i);
          if (!canvas) continue;
          await renderOne(viewer, i, canvas, wrapWidth, zoom).catch(fail);
          if (!isCurrent()) return;
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [mode, slideIndex, slideCount, zoom, wrapWidth, props.path, renderOne]);

  const goSlide = useCallback(
    (next: number): void => {
      setSlideIndex(Math.min(Math.max(0, next), Math.max(0, slideCount - 1)));
    },
    [slideCount],
  );

  const diveInto = useCallback((index: number): void => {
    setSlideIndex(index);
    setMode('paged');
  }, []);

  if (bytesState.status === 'loading') {
    return <div className="preview__empty">Loading deck…</div>;
  }
  if (bytesState.status === 'error') {
    return <div className="preview__empty">Could not load deck: {bytesState.message}</div>;
  }
  if (error !== '') {
    return <div className="preview__empty">Could not render deck: {error}</div>;
  }

  return (
    <div className="preview__paged" role="region" aria-label="Slide preview">
      <div className="preview__toolbar">
        {mode === 'paged' ? (
          <>
            <button type="button" onClick={() => goSlide(slideIndex - 1)} disabled={slideIndex <= 0} aria-label="Previous slide">‹</button>
            <span className="preview__page-label">
              {slideCount === 0 ? '…' : `${slideIndex + 1} / ${slideCount}`}
            </span>
            <button type="button" onClick={() => goSlide(slideIndex + 1)} disabled={slideIndex >= slideCount - 1} aria-label="Next slide">›</button>
          </>
        ) : (
          <span className="preview__page-label">{slideCount} slides</span>
        )}
        <span className="preview__sep" aria-hidden="true">·</span>
        <button type="button" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.25))} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out">−</button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          disabled={zoom === 1}
          aria-label="Fit width"
          title="Fit width"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.25))} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in">+</button>
        <span className="preview__sep" aria-hidden="true">·</span>
        <button
          type="button"
          onClick={() => setMode(mode === 'paged' ? 'all' : 'paged')}
          aria-label={mode === 'paged' ? 'Show all slides' : 'Show one slide'}
          title={mode === 'paged' ? '连续滚动：全部幻灯片' : '单页浏览'}
          aria-pressed={mode === 'all'}
        >
          {mode === 'paged' ? '全部' : '单页'}
        </button>
      </div>
      {mode === 'paged' ? (
        <div ref={wrapRef} className="preview__canvas-wrap preview__canvas-wrap--fit">
          <canvas ref={canvasRef} className="preview__canvas preview__canvas--fit" />
        </div>
      ) : (
        <div ref={wrapRef} className="preview__slides">
          {Array.from({ length: slideCount }, (_, i) => (
            <button
              key={i}
              type="button"
              className="preview__slide"
              onClick={() => diveInto(i)}
              title={`Open slide ${i + 1}`}
              aria-label={`Open slide ${i + 1} of ${slideCount}`}
            >
              <canvas
                ref={(el) => {
                  if (el) slideCanvasRefs.current.set(i, el);
                  else slideCanvasRefs.current.delete(i);
                }}
                className="preview__canvas preview__canvas--fit"
              />
              <span className="preview__slide-label">{i + 1} / {slideCount}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

/** Render only nearby thumbnails, using the same document/worker as the reader. */
function Thumbnail({ document, number, active, onSelect, scrollRoot }: {
  document: PDFDocumentProxy; number: number; active: boolean;
  onSelect: (number: number) => void; scrollRoot: HTMLElement | null;
}): ReactElement {
  const button = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    if (!button.current || !scrollRoot) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { root: scrollRoot, rootMargin: '160px' });
    observer.observe(button.current);
    return () => observer.disconnect();
  }, [scrollRoot]);
  useEffect(() => {
    if (active) button.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [active]);
  useEffect(() => {
    if (!visible || !canvas.current) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    const target = canvas.current;
    void document.getPage(number).then(async page => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale: 1 });
      const preview = page.getViewport({ scale: 208 / viewport.width });
      target.width = Math.ceil(preview.width); target.height = Math.ceil(preview.height);
      task = page.render({ canvas: target, viewport: preview });
      await task.promise;
      if (!cancelled) setRendered(true);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; task?.cancel(); };
  }, [document, number, visible]);
  return <button ref={button} type="button" className="preview__thumbnail" aria-label={`转到第 ${number} 页`}
    aria-busy={!rendered && !failed} aria-current={active ? 'page' : undefined} onClick={() => onSelect(number)}>
    <span className="preview__thumbnail-paper">{failed ? <span>预览不可用</span> : <canvas ref={canvas} data-rendered={rendered ? "true" : undefined} aria-hidden="true" />}</span>
    <span className="preview__thumbnail-number">{number}</span>
  </button>;
}
export function PdfThumbnails({ document, page, onSelect }: {
  document: PDFDocumentProxy; page: number; onSelect: (number: number) => void;
}): ReactElement {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return <nav className="preview__thumbnails" aria-label="页面缩略图">
    <div className="preview__thumbnails-heading">页面 <span>{document.numPages}</span></div>
    <div ref={setRoot} className="preview__thumbnails-scroll">
      {Array.from({ length: document.numPages }, (_, index) => <Thumbnail key={index} document={document}
        number={index + 1} active={page === index + 1} onSelect={onSelect} scrollRoot={root} />)}
    </div>
  </nav>;
}

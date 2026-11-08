// Trylo Desktop — ImagePreview (base capability).
//
// WHY bytes → blob URL instead of readFile-as-text: images are binary;
// decoding them as UTF-8 garbles the peek and can blow up the rail on
// large files. This component fetches via `readFileBytes` (the same
// path the attachment system uses) and mints an object URL, revoked on
// unmount / path change so repeated peeks don't leak memory.
//
// A render failure (e.g. heic/tiff the webview can't decode) falls back
// to a plain message — never to a wall of binary garbage.

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCw, Scan } from 'lucide-react';
import { readPreviewBinary } from '../../host-adapter/preview/resources';
import { previewExtOf } from './previewKind';
import { decodeRasterPage } from '../../preview/providers/raster';
import { previewImageFormat } from '../../preview/image-format';

export interface ImagePreviewProps {
  readonly path: string;
  readonly allowedRoot?: string;
  readonly bytes?: Uint8Array;
}

type ImageState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly url: string; readonly pageCount: number }
  | { readonly status: 'error'; readonly message: string };

export function ImagePreview(props: ImagePreviewProps): ReactElement {
  const key = `${props.allowedRoot ?? ''}\0${props.path}`;
  const [loaded, setLoaded] = useState<{ key: string; bytes?: Uint8Array; state: ImageState }>({ key: '', state: { status: 'loading' } });
  const state: ImageState = loaded.key === key && loaded.bytes === props.bytes ? loaded.state : { status: 'loading' };
  const setState = (state: ImageState): void => setLoaded({ key, bytes: props.bytes, state });
  const [zoom, setZoom] = useState<number | undefined>();
  const [rotation, setRotation] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [props.path, props.allowedRoot, props.bytes]);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observe = (): void => setViewport({ width: Math.max(1, wrap.clientWidth - 32), height: Math.max(1, wrap.clientHeight - 24) });
    const observer = new ResizeObserver(observe); observer.observe(wrap); observe();
    return () => observer.disconnect();
  }, [state.status]);
  const rotated = rotation % 180 !== 0;
  const width = rotated ? size.height : size.width;
  const height = rotated ? size.width : size.height;
  const fitScale = width && height && viewport.width ? Math.min(1, viewport.width / width, viewport.height / height) : 1;
  const displayScale = zoom ?? fitScale;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    const abort = new AbortController();
    setState({ status: 'loading' });
    setZoom(undefined); setRotation(0); setSize({ width: 0, height: 0 });
    (props.bytes ? Promise.resolve(props.bytes) : readPreviewBinary(props.path, props.allowedRoot))
      .then(async (bytes) => {
        if (cancelled) return;
        const extension = previewExtOf(props.path);
        const format = previewImageFormat(extension, bytes.subarray(0, 8192));
        const decoded = format?.decoder ? await decodeRasterPage(bytes, format.decoder, page, abort.signal) : undefined;
        if (cancelled) return;
        const mime = format?.mime ?? 'application/octet-stream';
        const blob = decoded?.blob ?? new Blob([bytes as BlobPart], { type: mime });
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', url: objectUrl, pageCount: decoded?.pageCount ?? 1 });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', message });
      });
    return () => {
      cancelled = true;
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [props.path, props.allowedRoot, props.bytes, key, page]);

  if (state.status === 'loading') {
    return <div className="preview__empty">Loading image…</div>;
  }
  if (state.status === 'error') {
    return <div className="preview__empty">Could not load image: {state.message}</div>;
  }
  return (
    <div className="preview__paged">
      <div className="preview__toolbar" role="toolbar" aria-label="Image controls">
        {state.pageCount > 1 && <><button type="button" aria-label="上一幅图像" disabled={!page} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {state.pageCount}</span><button type="button" aria-label="下一幅图像" disabled={page + 1 >= state.pageCount} onClick={() => setPage(page + 1)}>下一页</button></>}
        <button type="button" aria-label="Zoom out" onClick={() => setZoom(Math.max(.1, displayScale / 1.25))}><Minus size={15} /></button>
        <span>{zoom ? `${Math.round(zoom * 100)}%` : '适合窗口'}</span>
        <button type="button" aria-label="Zoom in" onClick={() => setZoom(Math.min(5, displayScale * 1.25))}><Plus size={15} /></button>
        <button type="button" onClick={() => setZoom(1)}>1:1</button>
        <button type="button" aria-label="Fit image" onClick={() => { setZoom(undefined); setRotation(0); }}><Scan size={15} /></button>
        <button type="button" aria-label="Rotate image" onClick={() => setRotation((r) => (r + 90) % 360)}><RotateCw size={15} /></button>
        {size.width > 0 && <span className="preview__view-note">{size.width} × {size.height}</span>}
      </div>
    <div ref={wrapRef} className="preview__image-wrap" role="region" aria-label="Image preview">
      <div className="preview__image-stage" style={{ width: width * displayScale || '100%', height: height * displayScale || undefined }}>
      <img
        className="preview__image"
        src={state.url}
        alt={props.path}
        style={size.width ? { position: 'absolute', left: '50%', top: '50%', maxWidth: 'none', width: size.width * displayScale, transform: `translate(-50%, -50%) rotate(${rotation}deg)` } : undefined}
        onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setState({
          status: 'error',
          message: 'this format cannot be rendered here — open with the system viewer.',
        })}
      />
      </div>
    </div>
    </div>
  );
}

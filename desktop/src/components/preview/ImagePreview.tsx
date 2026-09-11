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
import { useEffect, useState } from 'react';
import { hostAdapter } from '../../host-adapter';
import { previewExtOf } from './previewKind';

const MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
]);

export interface ImagePreviewProps {
  readonly path: string;
}

type ImageState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly url: string }
  | { readonly status: 'error'; readonly message: string };

export function ImagePreview(props: ImagePreviewProps): ReactElement {
  const [state, setState] = useState<ImageState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ status: 'loading' });
    hostAdapter.fs
      .readFileBytes(props.path)
      .then((bytes) => {
        if (cancelled) return;
        const mime = MIME_BY_EXT.get(previewExtOf(props.path)) ?? 'application/octet-stream';
        const blob = new Blob([bytes as BlobPart], { type: mime });
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', url: objectUrl });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', message });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [props.path]);

  if (state.status === 'loading') {
    return <div className="preview__empty">Loading image…</div>;
  }
  if (state.status === 'error') {
    return <div className="preview__empty">Could not load image: {state.message}</div>;
  }
  return (
    <div className="preview__image-wrap" role="region" aria-label="Image preview">
      <img
        className="preview__image"
        src={state.url}
        alt={props.path}
        onError={() => setState({
          status: 'error',
          message: 'this format cannot be rendered here — open with the system viewer.',
        })}
      />
    </div>
  );
}

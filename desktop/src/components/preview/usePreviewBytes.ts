// Trylo Desktop — shared byte loader for binary previews.
//
// PDF / Office / 3D renderers all need raw bytes, never the UTF-8
// `content` FilePeek carries for text. One hook owns the load —
// cancelled-guard, single state shape — so the five consumers stay
// thin and behave identically on slow disks and missing files.

import { useEffect, useState } from 'react';
import { readPreviewBinary } from '../../host-adapter/preview/resources';

export type PreviewBytesState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly bytes: Uint8Array }
  | { readonly status: 'error'; readonly message: string };

/** Load a file's raw bytes through the HostAdapter (the only IPC path). */
export function usePreviewBytes(path: string, suppliedBytes?: Uint8Array, allowedRoot?: string): PreviewBytesState {
  const key = `${allowedRoot ?? ''}\0${path}`;
  const [loaded, setLoaded] = useState<{ key: string; state: PreviewBytesState }>({ key, state: { status: 'loading' } });

  useEffect(() => {
    let cancelled = false;
    if (suppliedBytes) return undefined;
    const setState = (state: PreviewBytesState): void => setLoaded({ key, state });
    setState({ status: 'loading' });
    readPreviewBinary(path, allowedRoot)
      .then((bytes) => {
        if (cancelled) return;
        setState({ status: 'ready', bytes });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [path, suppliedBytes, allowedRoot, key]);

  if (suppliedBytes) return { status: 'ready', bytes: suppliedBytes };
  // Never expose stale bytes during the render before the new effect.
  return loaded.key === key ? loaded.state : { status: 'loading' };
}

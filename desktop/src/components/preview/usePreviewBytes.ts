// Trylo Desktop — shared byte loader for binary previews.
//
// PDF / Office / 3D renderers all need raw bytes, never the UTF-8
// `content` FilePeek carries for text. One hook owns the load —
// cancelled-guard, single state shape — so the five consumers stay
// thin and behave identically on slow disks and missing files.

import { useEffect, useState } from 'react';
import { hostAdapter } from '../../host-adapter';

export type PreviewBytesState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly bytes: Uint8Array }
  | { readonly status: 'error'; readonly message: string };

/** Load a file's raw bytes through the HostAdapter (the only IPC path). */
export function usePreviewBytes(path: string): PreviewBytesState {
  const [state, setState] = useState<PreviewBytesState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    hostAdapter.fs
      .readFileBytes(path)
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
  }, [path]);

  return state;
}

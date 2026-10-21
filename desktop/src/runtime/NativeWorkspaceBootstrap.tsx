import { useEffect, useState, type ReactElement } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../host-adapter/tauri-detect';

type StartupState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly root?: string }
  | { readonly kind: 'failed'; readonly error: Error };

/** Do not start CLI prewarm, history writes or watchers in a placeholder folder. */
export function NativeWorkspaceBootstrap({ children }: {
  readonly children: (root: string | undefined) => ReactElement;
}): ReactElement {
  const [state, setState] = useState<StartupState>(() => isTauri() ? { kind: 'loading' } : { kind: 'ready' });
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      cancelled = true;
      setState({ kind: 'failed', error: new Error('准备本地工作区超时，请重新加载后重试。') });
    }, 15000);
    void invoke<string>('default_workspace_root').then(root => {
      if (typeof root !== 'string' || !root.trim() || !/^(?:[a-z]:[\\/]|[\\/])/i.test(root)) {
        throw new Error('无法准备本地工作区：未取得有效目录。');
      }
      if (!cancelled) setState({ kind: 'ready', root });
    }).catch(() => {
      if (!cancelled) setState({ kind: 'failed', error: new Error('无法准备本地工作区，请重新加载后重试。') });
    }).finally(() => window.clearTimeout(timer));
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);
  if (state.kind === 'failed') throw state.error; // Existing AppErrorBoundary provides recovery.
  if (state.kind === 'loading') {
    return <p role="status" aria-busy="true" style={{ padding: 32 }}>正在准备本地工作区…</p>;
  }
  return children(state.root);
}

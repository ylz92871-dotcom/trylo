// Trylo Desktop — useEditorBridge. See ARCHITECTURE.md §2.5 + §2.3.
//
// B (corrected) refactor: the bridge owns its `buffer` (the
// editor's in-memory content for this file). The hook subscribes
// to the bridge's onBufferChange, onLoadChange, onDirtyChange,
// onConflict. The hook returns `buffer` as the source of truth
// for the editor's value prop; the App.tsx no longer needs a
// separate buffers Map.

import { useCallback, useEffect, useState } from 'react';
import {
  EditorBridgeImpl,
  type LoadState,
} from './editor-bridge-impl';
import type {
  ConflictEvent,
  FileChangeEvent,
  FilePath,
} from './index';

export interface UseEditorBridgeResult {
  readonly load: LoadState;
  readonly dirty: boolean;
  readonly buffer: string;
  readonly conflict: ConflictEvent | null;
  readonly setBuffer: (value: string) => void;
  readonly setLoad: (load: LoadState) => void;
  readonly reload: () => Promise<void>;
  readonly acceptExternal: () => Promise<void>;
  readonly keepMine: () => Promise<void>;
}

export function useEditorBridge(bridge: EditorBridgeImpl | null): UseEditorBridgeResult {
  const [load, setLoadState] = useState<LoadState>(
    bridge ? bridge.getLoad() : { kind: 'loading' },
  );
  const [buffer, setBufferState] = useState<string>(
    bridge ? bridge.getBuffer() : '',
  );
  const [dirty, setDirty] = useState<boolean>(bridge ? bridge.isDirty() : false);
  const [conflict, setConflict] = useState<ConflictEvent | null>(null);

  // Reset to the new bridge's state when the bridge instance
  // changes (tab switch). Without this, stale load/buffer would
  // flash before the new one updates.
  useEffect(() => {
    if (bridge) {
      setLoadState(bridge.getLoad());
      setBufferState(bridge.getBuffer());
      setDirty(bridge.isDirty());
      setConflict(null);
    } else {
      setLoadState({ kind: 'loading' });
      setBufferState('');
      setDirty(false);
      setConflict(null);
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    const u1 = bridge.onLoadChange(setLoadState);
    const u2 = bridge.onBufferChange(setBufferState);
    const u3 = bridge.onDirtyChange(setDirty);
    const u4 = bridge.onConflict(setConflict);
    return () => {
      u1();
      u2();
      u3();
      u4();
    };
  }, [bridge]);

  const setBuffer = useCallback(
    (value: string) => bridge?.setBuffer(value),
    [bridge],
  );
  const setLoad = useCallback(
    (l: LoadState) => bridge?.setLoad(l),
    [bridge],
  );
  const reload = useCallback(() => bridge?.reload() ?? Promise.resolve(), [bridge]);
  const acceptExternal = useCallback(
    () => bridge?.acceptExternal() ?? Promise.resolve(),
    [bridge],
  );
  const keepMine = useCallback(
    () => bridge?.keepMine() ?? Promise.resolve(),
    [bridge],
  );

  return {
    load,
    dirty,
    buffer,
    conflict,
    setBuffer,
    setLoad,
    reload,
    acceptExternal,
    keepMine,
  };
}

export function dispatchFileChange(
  bridges: ReadonlyMap<FilePath, EditorBridgeImpl>,
  event: FileChangeEvent,
): void {
  const bridge = bridges.get(event.path);
  if (bridge) {
    void bridge.onExternalEvent(event);
  }
}

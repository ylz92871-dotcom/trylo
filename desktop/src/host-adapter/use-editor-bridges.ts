// Trylo Desktop — useEditorBridges. See the architecture doc §2.5 + §2.3.
//
// The bridge registry holds one EditorBridgeImpl per open file.
// Switching tabs doesn't recreate the bridge — dirty / conflict
// state survives. This hook is the owner of the registry state;
// App.tsx is a thin consumer.
//
// API:
//   bridges:        the current Map<path, EditorBridgeImpl>
//   activeFile:     the path that's currently the active tab
//   activeBridge:   bridges.get(activeFile) ?? null
//   openFile(path): add to registry (or no-op if present), make
//                   active
//   closeFile(path): remove from registry; if it was active,
//                   fall back to the next remaining tab
//
// We don't expose a `getOrCreate` directly because React state
// updates are batched and the caller can't observe the bridge
// until the next render anyway. openFile() is the right primitive
// — callers fire-and-forget, and on the next render the new
// bridge is in `bridges`.

import { useCallback, useMemo, useState } from 'react';
import { EditorBridgeImpl } from './editor-bridge-impl';
import type { EditorBridgeFs } from './editor-bridge-impl';
import type { FilePath } from './index';

export interface UseEditorBridgesOptions {
  readonly fs: EditorBridgeFs;
  /** Initial set of open tabs. Defaults to an empty registry. */
  readonly initial?: { readonly paths: readonly FilePath[]; readonly active: FilePath | null };
}

export interface UseEditorBridgesResult {
  readonly bridges: ReadonlyMap<FilePath, EditorBridgeImpl>;
  readonly activeFile: FilePath | null;
  readonly activeBridge: EditorBridgeImpl | null;
  readonly openFile: (path: FilePath) => void;
  readonly closeFile: (path: FilePath) => void;
}

export function useEditorBridges(opts: UseEditorBridgesOptions): UseEditorBridgesResult {
  const [bridges, setBridges] = useState<Map<FilePath, EditorBridgeImpl>>(
    () => {
      if (!opts.initial) return new Map();
      const m = new Map<FilePath, EditorBridgeImpl>();
      for (const p of opts.initial.paths) {
        m.set(p, new EditorBridgeImpl({ path: p, fs: opts.fs }));
      }
      return m;
    },
  );
  const [activeFile, setActiveFile] = useState<FilePath | null>(
    opts.initial?.active ?? null,
  );

  const openFile = useCallback(
    (path: FilePath) => {
      setBridges((prev) => {
        if (prev.has(path)) return prev;
        const next = new Map(prev);
        next.set(path, new EditorBridgeImpl({ path, fs: opts.fs }));
        return next;
      });
      setActiveFile(path);
    },
    [opts.fs],
  );

  const closeFile = useCallback(
    (path: FilePath) => {
      setBridges((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Map(prev);
        next.delete(path);
        return next;
      });
      if (activeFile === path) {
        // Pick a neighbor from the remaining open tabs.
        const remaining = [...bridges.keys()].filter((p) => p !== path);
        setActiveFile(remaining[0] ?? null);
      }
    },
    [activeFile, bridges],
  );

  const activeBridge = useMemo(
    () => (activeFile ? bridges.get(activeFile) ?? null : null),
    [activeFile, bridges],
  );

  return {
    bridges,
    activeFile,
    activeBridge,
    openFile,
    closeFile,
  };
}

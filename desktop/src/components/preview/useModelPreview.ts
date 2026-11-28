// Owns one mounted renderer and its latest scoped file-load generation.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readPreviewBinary } from '../../host-adapter/preview/resources';
import { previewExtOf } from './previewKind';
import { disposeModelObject, parseModel } from './modelScene';
import { createModelViewer } from './modelViewer';
import type { ModelViewer } from './modelViewer';
import type { ModelPreviewController, ModelPreviewProps, ModelPreviewState } from './modelPreviewController';

export function useModelPreview(props: ModelPreviewProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const viewerRef = useRef<ModelViewer>();
  const activeRef = useRef(false);
  const abortRef = useRef<AbortController>();
  const initializationError = useRef<Error>();
  const identityRef = useRef<{ path: string; root?: string }>();
  const pendingRef = useRef<Promise<ModelPreviewState>>();
  const stateRef = useRef<ModelPreviewState>({
    status: 'loading', path: props.path, revision: props.revision ?? null,
    version: 0, readyVersion: null, wireframe: false,
  });
  const [state, setState] = useState(stateRef.current);

  const publish = useCallback((value: ModelPreviewState): void => {
    stateRef.current = value;
    if (!activeRef.current) return;
    setState(value);
    propsRef.current.onStateChange?.(value);
  }, []);
  const requireReady = useCallback((): ModelViewer => {
    const current = stateRef.current;
    const latest = propsRef.current;
    if (!activeRef.current || !viewerRef.current || current.status !== 'ready'
      || current.path !== latest.path || current.revision !== (latest.revision ?? null)
      || (latest.expectedFileSignature !== undefined && current.fileSignature !== latest.expectedFileSignature.toLowerCase())
      || identityRef.current?.root !== latest.allowedRoot) throw new Error('模型当前版本尚未就绪');
    return viewerRef.current;
  }, []);

  const load = useCallback((): Promise<ModelPreviewState> => {
    const input = propsRef.current;
    const version = stateRef.current.version + 1;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    const viewer = viewerRef.current;
    const sameScope = identityRef.current?.path === input.path && identityRef.current.root === input.allowedRoot;
    identityRef.current = { path: input.path, root: input.allowedRoot };
    if (!sameScope) viewer?.clear();
    const loading: ModelPreviewState = {
      status: 'loading', path: input.path, revision: input.revision ?? null,
      version, readyVersion: null, wireframe: sameScope && stateRef.current.wireframe,
    };
    publish(loading);

    const pending = (async (): Promise<ModelPreviewState> => {
      try {
        if (!activeRef.current || !viewer) throw initializationError.current ?? new Error('模型查看器已关闭');
        const bytes = await readPreviewBinary(input.path, input.allowedRoot);
        if (abort.signal.aborted) throw new Error('模型加载已被更新版本替代');
        let fileSignature: string | undefined;
        if (input.expectedFileSignature !== undefined) {
          if (!globalThis.crypto?.subtle) throw new Error('model_preview_signature_verification_unavailable');
          const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
          fileSignature = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
          if (abort.signal.aborted) throw new Error('模型加载已被更新版本替代');
          if (fileSignature !== input.expectedFileSignature.toLowerCase()) throw new Error('model_preview_file_changed_before_render');
        }
        const model = await parseModel(previewExtOf(input.path), bytes, input.path, input.allowedRoot, abort.signal);
        if (abort.signal.aborted) {
          disposeModelObject(model);
          throw new Error('模型加载已被更新版本替代');
        }
        const scene = viewer.setModel(model);
        const ready: ModelPreviewState = { ...loading, status: 'ready', readyVersion: version, scene,
          ...(fileSignature === undefined ? {} : { fileSignature }) };
        publish(ready);
        return ready;
      } catch (error: unknown) {
        const failure = error instanceof Error ? error : new Error(String(error));
        // Superseded loads belong to their original caller and never overwrite the current generation.
        if (!abort.signal.aborted && activeRef.current) publish({ ...loading, status: 'error', message: failure.message });
        throw failure;
      }
    })();
    pendingRef.current = pending;
    return pending;
  }, [publish]);

  const controller = useMemo<ModelPreviewController>(() => ({
    getState: () => stateRef.current,
    reload: load,
    async waitUntilReady() {
      if (!activeRef.current) throw new Error('模型查看器已关闭');
      const pending = pendingRef.current;
      if (!pending) throw new Error('模型尚未开始加载');
      const ready = await pending;
      requireReady();
      if (ready.version !== stateRef.current.version) throw new Error('模型加载已被更新版本替代');
      return ready;
    },
    setCamera: (view) => requireReady().setCamera(view),
    setWireframe: (enabled) => {
      requireReady().setWireframe(enabled);
      publish({ ...stateRef.current, wireframe: enabled });
    },
    async capture(options) {
      const viewer = requireReady();
      const current = stateRef.current;
      const captured = viewer.capture(options);
      return { ...captured, path: current.path, revision: current.revision, version: current.version,
        ...(current.fileSignature === undefined ? {} : { fileSignature: current.fileSignature }) };
    },
  }), [load, publish, requireReady]);

  useEffect(() => {
    activeRef.current = true;
    try {
      if (mountRef.current) viewerRef.current = createModelViewer(mountRef.current);
    } catch (error: unknown) {
      initializationError.current = error instanceof Error ? error : new Error(String(error));
    }
    return () => {
      activeRef.current = false;
      abortRef.current?.abort();
      viewerRef.current?.dispose();
      viewerRef.current = undefined;
    };
  }, []);
  useEffect(() => {
    // The published state owns automatic-load errors. Imperative reload retains its rejecting Promise.
    void load().then(() => undefined, () => undefined);
  }, [props.path, props.allowedRoot, props.revision, props.expectedFileSignature, load]);
  const { onController } = props;
  useEffect(() => {
    onController?.(controller);
    return () => onController?.(null);
  }, [onController, controller]);

  return { mountRef, state, controller };
}

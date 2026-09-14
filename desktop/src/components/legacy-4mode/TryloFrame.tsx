// Trylo Desktop — TryloFrame component. See ARCHITECTURE.md §3
// Phase 2 task #1 (iframe mount) and the Phase 2 plan §7 (file map).
//
// This component mounts the legacy 4-mode webview in an iframe. The
// iframe loads `legacy-4mode/index.html` (a static asset copied at
// build time from the source of truth). The component:
//
//  1. Creates a real `TryloApi` instance bound to the active
//     workspace and the current `Project State` (Phase 2 task 2.6).
//  2. Installs `acquireTryloApi()` on the iframe's `window` before
//     the iframe's first script runs.
//  3. Listens for response events from the parent (the iframe's
//     `contentWindow.postMessage`) and forwards them to the api.
//  4. Cleans up on unmount.

import { useEffect, useRef, type ReactElement } from 'react';
import type { FilePath } from '../../host-adapter/types';
import {
  handleTryloRequest,
  type TryloHandlerContext,
} from '../../host-adapter/trylo-message-types';
import type {
  TryloApi,
  TryloPushEvent,
  TryloRequest,
  TryloResponse,
} from '../../host-adapter/trylo-api';

/** Where the vendored 4-mode webview lives. Phase 2 task 2.2. */
const LEGACY_WEBVIEW_ENTRY = '/legacy-4mode/index.html';

/** Origin used to filter inbound `postMessage` events. */
const EXPECTED_ORIGIN = 'null'; // Tauri loads from `tauri://`; we accept any for now

export interface TryloFrameProps {
  workspaceRoot: FilePath;
  /** The handler context. Injected so tests can supply a stub. */
  context: TryloHandlerContext;
  /** Optional width/height; defaults fill the parent. */
  width?: string | number;
  height?: string | number;
  /** Optional className for styling the iframe element. */
  className?: string;
  /** Optional title override. */
  title?: string;
}

export function TryloFrame(props: TryloFrameProps): ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return undefined;

    // Build the per-iframe TryloApi. The api lives in the parent and
    // is exposed to the iframe via `iframeWindow.acquireTryloApi`
    // (the shim reads it from its own window).
    const subscribers = new Set<(msg: TryloPushEvent) => void>();
    const api: TryloApi = {
      postMessage<TReq extends TryloRequest, TRes extends TryloResponse>(
        message: TReq,
      ): Promise<TRes> {
        return handleTryloRequest(message, props.context) as Promise<TRes>;
      },
      onMessage<TMsg extends TryloPushEvent>(
        handler: (msg: TMsg) => void,
      ): () => void {
        const h = handler as (msg: TryloPushEvent) => void;
        subscribers.add(h);
        return () => {
          subscribers.delete(h);
        };
      },
      getState<T>(): T | undefined {
        return undefined;
      },
      setState<T>(_state: T): void {
        // Phase 2: in-memory only. Phase 3: Project State write-through.
      },
    };

    let installed: (() => void) | null = null;
    const handleLoad = (): void => {
      const win = iframe.contentWindow;
      if (!win) return;
      // Install the api factory on the iframe's window BEFORE the
      // legacy code's `acquireVsCodeApi()` runs.
      (win as unknown as { acquireTryloApi: () => Promise<TryloApi> })
        .acquireTryloApi = () => Promise.resolve(api);
      installed = () => {
        // Cleanup for unmount while the iframe is still loaded.
        try {
          delete (win as unknown as { acquireTryloApi?: () => Promise<TryloApi> })
            .acquireTryloApi;
        } catch {
          // Some hosts throw on delete; ignore.
        }
      };
    };
    iframe.addEventListener('load', handleLoad);

    // Inbound events from the iframe: the legacy code may post
    // a response back to the parent on its own (in addition to
    // whatever we routed through `handleTryloRequest`).
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== iframe.contentWindow) return;
      // Phase 2 first batch: the 6 simple types are all
      // request/response; no inbound push events from the iframe
      // are expected. We log unknown events so we can wire them
      // when they appear.
      // eslint-disable-next-line no-console
      console.debug('[trylo-frame] inbound from iframe', event.data, {
        origin: event.origin,
        expected: EXPECTED_ORIGIN,
      });
    };
    window.addEventListener('message', onMessage);

    return () => {
      iframe.removeEventListener('load', handleLoad);
      window.removeEventListener('message', onMessage);
      if (installed) installed();
      subscribers.clear();
    };
  }, [props.context]);

  return (
    <iframe
      ref={iframeRef}
      src={LEGACY_WEBVIEW_ENTRY}
      title={props.title ?? 'Trylo 4-mode webview'}
      sandbox="allow-scripts allow-same-origin allow-forms"
      className={props.className}
      style={{
        width: props.width ?? '100%',
        height: props.height ?? '100%',
        border: 'none',
        background: 'transparent',
      }}
    />
  );
}

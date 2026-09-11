// Trylo Desktop — Browser preview controller (renderer side of the
// viewport bridge).
//
// Architecture forked from auchenberg/vscode-browser-preview (MIT): the
// sidecar streams `Page.screencastFrame` JPEGs as `tooling.viewportFrame`
// events; this hook keeps the latest frame in a ref and surfaces a
// monotonic `frameSeq` so the panel's canvas can redraw efficiently
// (damage-driven stream — a static page sends no frames).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServiceManager } from '../services-host/service-manager';
import type { ViewportFrameEvent, ViewportInputParams, ViewportStatusEvent } from '../services-host/methods';
import type { ToolingFacade } from './tooling-facade';

export type ViewportFrame = ViewportFrameEvent;
export type ViewportStatus = ViewportStatusEvent['state'];

export interface BrowserPreviewController {
  readonly status: ViewportStatus;
  readonly detail: string;
  readonly url: string;
  /** Bumps once per redrawn frame — the canvas effect's dependency. */
  readonly frameSeq: number;
  readonly latestFrame: ViewportFrame | null;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly navigate: (url: string) => Promise<void>;
  readonly input: (params: ViewportInputParams) => Promise<void>;
}

export function useBrowserPreview(options: {
  readonly facade: ToolingFacade | null;
  readonly serviceManager: ServiceManager | null;
}): BrowserPreviewController {
  const { facade, serviceManager } = options;
  const [status, setStatus] = useState<ViewportStatus>('stopped');
  const [detail, setDetail] = useState('');
  const [url, setUrl] = useState('');
  const [frameSeq, setFrameSeq] = useState(0);
  const latestFrameRef = useRef<ViewportFrame | null>(null);
  const bumpScheduledRef = useRef(false);

  // Frames are damage-driven and can burst (scroll, animation). Coalesce
  // them into one React update per animation frame.
  useEffect(() => {
    if (!serviceManager) return undefined;
    const client = serviceManager.client;
    const offFrame = client.onEvent('tooling.viewportFrame', (frame) => {
      latestFrameRef.current = frame;
      if (bumpScheduledRef.current) return;
      bumpScheduledRef.current = true;
      requestAnimationFrame(() => {
        bumpScheduledRef.current = false;
        setFrameSeq((seq) => seq + 1);
      });
    });
    const offStatus = client.onEvent('tooling.viewportStatus', (event) => {
      setStatus(event.state);
      setDetail(event.detail ?? '');
      if (typeof event.url === 'string' && event.url !== '') setUrl(event.url);
    });
    return () => {
      offFrame();
      offStatus();
    };
  }, [serviceManager]);

  const start = useCallback(async (): Promise<void> => {
    if (!facade) return;
    setStatus('starting');
    setDetail('');
    const result = await facade.viewportStart();
    if (result.ok) {
      setStatus('running');
      if (result.url) setUrl(result.url);
    } else {
      setStatus('error');
      setDetail(result.error ?? result.reasonCode ?? '启动失败');
    }
  }, [facade]);

  const stop = useCallback(async (): Promise<void> => {
    if (!facade) return;
    await facade.viewportStop();
    latestFrameRef.current = null;
    setFrameSeq((seq) => seq + 1);
    setStatus('stopped');
    setDetail('');
  }, [facade]);

  const navigate = useCallback(async (next: string): Promise<void> => {
    if (!facade) return;
    const result = await facade.viewportNavigate(next);
    if (result.ok && result.url) setUrl(result.url);
  }, [facade]);

  const input = useCallback(async (params: ViewportInputParams): Promise<void> => {
    if (!facade) return;
    await facade.viewportInput(params);
  }, [facade]);

  return {
    status,
    detail,
    url,
    frameSeq,
    latestFrame: latestFrameRef.current,
    start,
    stop,
    navigate,
    input,
  };
}

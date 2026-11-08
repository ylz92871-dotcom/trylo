import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { openInteractiveWeb, type InteractiveWebSource, type WebPreviewBounds } from '../../host-adapter/preview/web';
import { PreviewFailure } from './PreviewFailure';

export function InteractiveWebPreview({ path, allowedRoot, onStatic }: { path: string; allowedRoot?: string; onStatic: () => void }): ReactElement {
  const holder = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<InteractiveWebSource>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  useEffect(() => {
    let stale = false, frame = 0, busy = false;
    let session: InteractiveWebSource | undefined;
    let disconnect: (() => void) | undefined;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastLayout = '';
    let pending: { bounds: WebPreviewBounds; visible: boolean } | undefined;
    const sync = (): void => {
      frame = 0;
      const element = holder.current;
      if (stale || !element || !session?.native) return;
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && document.visibilityState !== 'hidden' && !document.querySelector('[aria-modal="true"]');
      const bounds = { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
      const key = JSON.stringify({ bounds, visible });
      if (key === lastLayout) return;
      lastLayout = key; pending = { bounds, visible };
      if (busy) return;
      busy = true;
      void (async () => {
        try { while (!stale && pending) { const next = pending; pending = undefined; await session?.layout(next.bounds, next.visible); } }
        catch (reason) { if (!stale) { await session?.close().catch(() => {}); setError(String(reason)); } }
        finally { busy = false; }
      })();
    };
    const schedule = (): void => { if (!stale && !frame) frame = requestAnimationFrame(sync); };
    if (!allowedRoot) { setError('请先打开网页所在的项目。'); return; }
    void openInteractiveWeb(path, allowedRoot).then(async (result) => {
      if (stale) { await result.close(); return; }
      session = result; setSource(result);
      unlisten = await result.onLoaded(() => { if (!stale) setLoading(false); });
      if (stale) { unlisten(); await result.close(); return; }
      const observer = new ResizeObserver(schedule); if (holder.current) observer.observe(holder.current);
      const mutations = new MutationObserver(schedule); mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-modal', 'style', 'class'] });
      window.addEventListener('resize', schedule); document.addEventListener('visibilitychange', schedule);
      disconnect = () => { observer.disconnect(); mutations.disconnect(); window.removeEventListener('resize', schedule); document.removeEventListener('visibilitychange', schedule); };
      const diagnostics = async (): Promise<void> => {
        try { const messages = await result.diagnostics(); if (!stale) setWarnings(messages); } catch { /* Reload remains available if the host stops. */ }
        if (!stale) timer = setTimeout(() => { void diagnostics(); }, 2000);
      };
      void diagnostics(); schedule();
    }).catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; cancelAnimationFrame(frame); clearTimeout(timer); disconnect?.(); unlisten?.(); void session?.close().catch(() => {}); };
  }, [path, allowedRoot]);
  if (error) return <PreviewFailure error={error}><button type="button" onClick={onStatic}>切换静态预览</button></PreviewFailure>;
  return <div className="preview__paged">
    {loading && <div className="preview__web-status" role="status">正在加载交互网页…</div>}
    {!!warnings.length && <details className="preview__web-status"><summary>{warnings.length} 项网页资源未能加载</summary>{warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>}
    <div ref={holder} className="preview__web-holder">
      {source && !source.native && <iframe className="preview__html" title="交互网页预览" src={source.url} sandbox="allow-scripts" onLoad={() => setLoading(false)} />}
    </div>
  </div>;
}

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { isTauri } from '../tauri-detect';

export interface PreviewMediaSource { readonly url: string; readonly mode?: 'file' | 'hls'; readonly duration?: number; readonly release: () => void }

/** Native Tauri asset protocol already supports HTTP ranges. Validate the
 * canonical project-contained target before minting a media URL. No full-file
 * IPC arrays or object URLs for recordings that can be hundreds of megabytes. */
export async function openPreviewMedia(filePath: string, allowedRoot: string): Promise<PreviewMediaSource> {
  if (isTauri()) {
    const path = await invoke<string>('preview_media_path', { filePath, allowedRoot });
    return { url: convertFileSrc(path), release: () => {} };
  }
  const response = await fetch('/__dev_preview/media', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath, allowedRoot }),
  });
  if (!response.ok) throw new Error(await response.text());
  const { token } = await response.json() as { token: string };
  return { url: `/__dev_preview/media/${encodeURIComponent(token)}`, release: () => { void fetch(`/__dev_preview/media/${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(() => {}); } };
}

/** A separate owned compatibility session. Cancellation is sent immediately,
 * even while the engine is still probing, and again for a late open result. */
export async function openCompatibleMedia(filePath: string, allowedRoot: string, signal: AbortSignal): Promise<PreviewMediaSource> {
  signal.throwIfAborted();
  const token = crypto.randomUUID();
  let released = false;
  const close = (): void => {
    if (isTauri()) void invoke('preview_media_close', { token }).catch(() => {});
    else void fetch(`/__dev_preview/media-compat/${token}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  };
  const release = (): void => { if (!released) { released = true; signal.removeEventListener('abort', release); close(); } };
  signal.addEventListener('abort', release, { once: true });
  try {
    let result: { url: string; duration: number };
    if (isTauri()) result = await invoke('preview_media_open', { token, filePath, allowedRoot });
    else {
      const response = await fetch('/__dev_preview/media-compat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, filePath, allowedRoot }), signal });
      if (!response.ok) throw new Error(await response.text()); result = await response.json() as typeof result;
    }
    if (released || signal.aborted) { close(); signal.throwIfAborted(); throw new Error('媒体预览已关闭'); }
    return { ...result, mode: 'hls', release };
  } catch (error) { release(); throw error; }
}

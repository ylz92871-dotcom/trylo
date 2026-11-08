import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '../tauri-detect';
export interface WebPreviewBounds { x: number; y: number; width: number; height: number }
export interface InteractiveWebSource {
  readonly token: string; readonly url: string; readonly native: boolean;
  layout(bounds: WebPreviewBounds, visible: boolean): Promise<void>;
  diagnostics(): Promise<readonly string[]>;
  close(): Promise<void>;
  onLoaded(callback: () => void): Promise<() => void>;
}
export async function openInteractiveWeb(filePath: string, allowedRoot: string): Promise<InteractiveWebSource> {
  const native = isTauri();
  let source: { token: string; url: string };
  if (native) source = await invoke('preview_web_open', { filePath, allowedRoot, token: crypto.randomUUID() });
  else {
    const response = await fetch('/__dev_preview/web', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath, allowedRoot }) });
    if (!response.ok) throw new Error(await response.text());
    source = await response.json() as { token: string; url: string };
  }
  const { token, url } = source;
  let closed = false;
  return {
    token, url, native,
    layout: async (bounds, visible) => { if (!closed && native) await invoke('preview_web_layout', { token, bounds, visible }); },
    diagnostics: async () => {
      if (closed) return [];
      if (native) return invoke('preview_web_status', { token });
      const response = await fetch(`/__dev_preview/web/${token}`);
      return response.ok ? response.json() as Promise<string[]> : [];
    },
    close: async () => {
      if (closed) return; closed = true;
      if (native) await invoke('preview_web_close', { token });
      else await fetch(`/__dev_preview/web/${token}`, { method: 'DELETE' });
    },
    onLoaded: async (callback) => native ? listen<{ token: string }>('preview-web-ready', (event) => { if (event.payload.token === token) callback(); }) : () => {},
  };
}

import { listen } from '@tauri-apps/api/event';
import { isMacPlatform } from '../utils/platform';
import { isTauri } from './tauri-detect';

/** Subscribe within an effect and dispose even if native registration is still pending. */
export function onMacosWake(callback: () => void): () => void {
  if (!isMacPlatform() || !isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen('trylo-system-wake', () => { if (!disposed) callback(); }).then(off => {
    if (disposed) off();
    else unlisten = off;
  }).catch(error => console.warn('无法监听 macOS 唤醒事件', error));
  return () => { disposed = true; unlisten?.(); };
}

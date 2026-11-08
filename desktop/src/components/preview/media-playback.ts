import type { PreviewMediaSource } from '../../host-adapter/preview/media';

/** The native element owns decoding and media events. hls.js only supplies
 * the compatibility stream; the React transport does not own the source. */
export async function attachMediaPlayback(element: HTMLMediaElement, source: PreviewMediaSource, signal: AbortSignal, onFailure: (message: string) => void): Promise<() => void> {
  const detach = (): void => { element.pause(); element.removeAttribute('src'); element.load(); };
  if (signal.aborted) return () => {};
  if (source.mode !== 'hls' || element.canPlayType('application/vnd.apple.mpegurl')) {
    element.src = source.url;
    return detach;
  }
  const { default: Hls } = await import('hls.js');
  if (signal.aborted) return () => {};
  if (!Hls.isSupported()) throw new Error('当前系统的媒体缓冲接口不可用，请更新 WebView2 后重试');
  const player = new Hls({ enableWorker: false, maxBufferLength: 18, maxMaxBufferLength: 30, backBufferLength: 30, maxBufferSize: 32 * 1024 * 1024 });
  player.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal && !signal.aborted) onFailure('兼容播放失败，请重新加载预览。文件可能损坏，或编码暂不支持。'); });
  player.attachMedia(element); player.loadSource(source.url);
  return () => { player.destroy(); detach(); };
}

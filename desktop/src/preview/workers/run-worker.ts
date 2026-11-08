import { previewCodecUrls } from '../../host-adapter/preview/codecs';

/** Every parsing job owns its worker. Closing a viewer or exceeding its budget
 * terminates native/WASM parsing rather than merely hiding a stale result. */
export function runPreviewWorker<T>(name: 'image' | 'cad' | 'archive', request: object, transfer: Transferable[], signal?: AbortSignal, budgetMs = 45_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
    const worker = new Worker(`/preview-workers/${name}-worker.js`);
    let settled = false;
    const finish = (error?: Error, result?: T): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = (): void => finish(new DOMException('已取消', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('预览解析超时，请尝试较小的文件或使用外部应用。')), budgetMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = (event): void => finish(new Error(event.message || '预览解析器无法运行。'));
    worker.onmessage = (event: MessageEvent<{ ok: boolean; result?: T; error?: string }>): void => {
      finish(event.data.ok ? undefined : new Error(event.data.error || '预览解析失败。'), event.data.result);
    };
    const provider = name === 'archive' ? 'archive' : name === 'cad' ? 'cad' : (request as { format?: string }).format === 'tiff' ? 'tiff' : 'heif';
    void previewCodecUrls(provider).then((codecs) => {
      if (settled) return;
      try { worker.postMessage({ ...request, codecs }, transfer); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    }, (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

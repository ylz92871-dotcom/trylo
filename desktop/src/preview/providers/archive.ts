import { runPreviewWorker } from '../workers/run-worker';
import type { ArchiveContents, ArchiveEntry } from './archive-types';
/** Each list/read owns a worker; the decoder has a 256 MB WASM ceiling. */
export async function loadArchivePreview(bytes: Uint8Array, name: string, signal: AbortSignal): Promise<ArchiveContents> {
  signal.throwIfAborted();
  if (bytes.length > 100 * 1024 * 1024) throw new Error('归档超过 100 MB 预览限制');
  if (bytes[0] === 80 && bytes[1] === 75) {
    const { loadZipPreview } = await import('./zip');
    return loadZipPreview(bytes, signal);
  }
  const run = <T>(action: 'list' | 'read', abort: AbortSignal, id?: number): Promise<T> => {
    abort.throwIfAborted(); const buffer = bytes.slice().buffer;
    return runPreviewWorker<T>('archive', { action, buffer, name, id }, [buffer], abort, 8000);
  };
  const entries = await run<ArchiveEntry[]>('list', signal);
  return { entries, read: async (id, abort) => {
    const entry = entries[id];
    if (!entry || entry.directory || entry.readable === false) throw new Error('请选择普通文件；链接和特殊条目不读取');
    if (entry.encrypted) throw new Error('此条目已加密，请使用外部应用');
    if (entry.size > 10 * 1024 * 1024) throw new Error('此条目解压后超过 10 MB 阅读限制');
    return new Uint8Array(await run<ArrayBuffer>('read', abort, id));
  } };
}

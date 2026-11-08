import { runPreviewWorker } from '../workers/run-worker';
export interface RasterPage { readonly blob: Blob; readonly pageCount: number; readonly width: number; readonly height: number }
export async function decodeRasterPage(bytes: Uint8Array, format: 'tiff' | 'heif', page: number, signal?: AbortSignal): Promise<RasterPage> {
  if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('TIFF / HEIC 预览支持 50 MB 以内的文件。');
  const buffer = bytes.slice().buffer;
  return runPreviewWorker<RasterPage>('image', { buffer, format, page }, [buffer], signal);
}

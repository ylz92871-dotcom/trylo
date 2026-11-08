import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { isTauri } from '../tauri-detect';
export type PreviewCodecUrls = { tiffPako: string; tiffUtif: string; heif: string; cad: string; cadWasm: string; archive: string; archiveWasm: string };
export async function previewCodecUrls(provider: 'tiff' | 'heif' | 'cad' | 'archive'): Promise<Partial<PreviewCodecUrls>> {
  if (!isTauri()) return { tiffPako: '/preview-codecs/tiff/pako.min.js', tiffUtif: '/preview-codecs/tiff/UTIF.js', heif: '/preview-codecs/heif/libheif-bundle.js', cad: '/preview-codecs/cad/occt-import-js.js', cadWasm: '/preview-codecs/cad/occt-import-js.wasm', archive: '/preview-codecs/archive/libarchive.js', archiveWasm: '/preview-codecs/archive/libarchive.wasm' };
  const paths = await invoke<Partial<PreviewCodecUrls>>('preview_codec_paths', { provider });
  return Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, convertFileSrc(path)]));
}

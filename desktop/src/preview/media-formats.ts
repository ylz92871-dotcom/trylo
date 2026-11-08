import formats from './media-formats.json';
export interface MediaFormat { readonly kind: 'audio' | 'video'; readonly mime: string; readonly ambiguous?: boolean }
export const MEDIA_FORMATS: Readonly<Record<string, MediaFormat>> = formats as Record<string, MediaFormat>;
export function mediaFormatFor(path: string): MediaFormat | undefined {
  return MEDIA_FORMATS[path.toLowerCase().match(/\.([^./\\]+)$/)?.[1] ?? ''];
}

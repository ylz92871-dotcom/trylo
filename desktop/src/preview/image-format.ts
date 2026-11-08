/** Shared byte evidence for image routing and decoder selection. */
export interface PreviewImageFormat {
  readonly mime: string;
  readonly decoder?: 'tiff' | 'heif';
}
const BY_EXTENSION: ReadonlyMap<string, PreviewImageFormat> = new Map([
  ['.png', { mime: 'image/png' }], ['.jpg', { mime: 'image/jpeg' }],
  ['.jpeg', { mime: 'image/jpeg' }], ['.webp', { mime: 'image/webp' }],
  ['.gif', { mime: 'image/gif' }], ['.bmp', { mime: 'image/bmp' }],
  ['.svg', { mime: 'image/svg+xml' }], ['.avif', { mime: 'image/avif' }],
  ['.ico', { mime: 'image/x-icon' }],
  ['.tif', { mime: 'image/tiff', decoder: 'tiff' }],
  ['.tiff', { mime: 'image/tiff', decoder: 'tiff' }],
  ['.heic', { mime: 'image/heic', decoder: 'heif' }],
  ['.heif', { mime: 'image/heif', decoder: 'heif' }],
]);
export function imageFormatFromHeader(head: Uint8Array): PreviewImageFormat | undefined {
  const starts = (...bytes: number[]): boolean => bytes.every((byte, index) => head[index] === byte);
  const text = (offset: number, count: number): string => String.fromCharCode(...head.subarray(offset, offset + count));
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return { mime: 'image/png' };
  if (starts(255, 216, 255)) return { mime: 'image/jpeg' };
  if (text(0, 3) === 'GIF') return { mime: 'image/gif' };
  if (text(0, 2) === 'BM') return { mime: 'image/bmp' };
  if (starts(0, 0, 1, 0)) return { mime: 'image/x-icon' };
  if (starts(73, 73, 42, 0) || starts(77, 77, 0, 42)) return { mime: 'image/tiff', decoder: 'tiff' };
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return { mime: 'image/webp' };
  if (text(4, 4) === 'ftyp') {
    const brand = text(8, 4);
    if (/^(?:avif|avis)$/.test(brand)) return { mime: 'image/avif' };
    if (/^(?:hei[cfmsx]|mif1|msf1)$/.test(brand)) return { mime: 'image/heif', decoder: 'heif' };
  }
  return undefined;
}
export function previewImageFormat(extension: string, head: Uint8Array): PreviewImageFormat | undefined {
  return imageFormatFromHeader(head) ?? BY_EXTENSION.get(extension.toLowerCase());
}

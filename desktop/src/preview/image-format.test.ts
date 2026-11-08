// @vitest-environment node
import { expect, it } from 'vitest';
import { imageFormatFromHeader, previewImageFormat } from './image-format';
import { sniffPreviewKind } from './sniff';

it('uses the same image evidence for routing and the chosen reader, independent of suffix', () => {
  for (const [header, decoder, mime] of [
    [[0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99], 'heif', 'image/heif'],
    [[73, 73, 42, 0, 8, 0, 0, 0], 'tiff', 'image/tiff'],
    [[137, 80, 78, 71, 13, 10, 26, 10], undefined, 'image/png'],
  ] as const) {
    const bytes = Uint8Array.from(header);
    expect(sniffPreviewKind('renamed.download', bytes)).toBe('image');
    expect(previewImageFormat('.download', bytes)).toEqual({ mime, ...(decoder ? { decoder } : {}) });
  }
});
it('keeps AVIF and video out of the HEIF worker and preserves suffix fallback without header evidence', () => {
  const ftyp = (brand: string) => Uint8Array.from([0, 0, 0, 24, ...Buffer.from(`ftyp${brand}`)]);
  expect(imageFormatFromHeader(ftyp('avif'))).toEqual({ mime: 'image/avif' });
  expect(imageFormatFromHeader(ftyp('isom'))).toBeUndefined();
  expect(sniffPreviewKind('recording.download', ftyp('isom'))).toBe('video');
  expect(previewImageFormat('.TIFF', new Uint8Array())).toEqual({ mime: 'image/tiff', decoder: 'tiff' });
});

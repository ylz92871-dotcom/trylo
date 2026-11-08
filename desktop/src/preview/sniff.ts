import { previewKindFor, type PreviewKind } from './formats';
import { imageFormatFromHeader } from './image-format';
/** Bounded header detection for ambiguous/misnamed files. No content executes. */
export function sniffPreviewKind(path: string, head: Uint8Array): PreviewKind {
  const named = previewKindFor(path);
  const starts = (...bytes: number[]): boolean => bytes.every((byte, index) => head[index] === byte);
  const text = (offset: number, count: number): string => String.fromCharCode(...head.subarray(offset, offset + count));
  if (text(0, 5) === '%PDF-') return 'pdf';
  if (imageFormatFromHeader(head)) return 'image';
  if (text(0, 4) === 'RIFF') {
    if (text(8, 4) === 'WAVE') return 'audio';
    if (text(8, 4) === 'AVI ') return 'video';
  }
  if (text(4, 4) === 'ftyp') {
    const brand = text(8, 4);
    return /^(?:M4A |M4B |F4A )$/.test(brand) ? 'audio' : 'video';
  }
  if (starts(26, 69, 223, 163) || text(0, 3) === 'FLV' || starts(48, 38, 178, 117, 142, 102, 207, 17)) return 'video';
  if (text(0, 3) === 'ID3' || text(0, 4) === 'fLaC' || text(0, 4) === 'caff' || text(0, 6) === '#!AMR\n') return 'audio';
  if (text(0, 4) === 'OggS') return text(0, Math.min(1024, head.length)).includes('theora') ? 'video' : 'audio';
  for (const [offset, packet] of [[0, 188], [4, 192]] as const) {
    if (head.length > offset + packet * 3 + 3 && [0, 1, 2, 3].every((index) => head[offset + packet * index] === 0x47 && (head[offset + packet * index + 3]! & 0x30) !== 0)) return 'video';
  }
  if (starts(255, 254) || starts(254, 255)) return previewKindFor(path);
  if (starts(80, 75, 3, 4) || starts(80, 75, 5, 6)) return ['docx', 'xlsx', 'pptx', 'office', 'model3d'].includes(named) ? named : 'archive';
  if (starts(55, 122, 188, 175, 39, 28) || text(0, 7) === 'Rar!\x1a\x07\x00' || text(0, 7) === 'Rar!\x1a\x07\x01' || starts(31, 139) || text(0, 3) === 'BZh' || starts(253, 55, 122, 88, 90, 0) || starts(40, 181, 47, 253) || text(257, 5) === 'ustar' || text(0, 8) === '!<arch>\n') return 'archive';
  if (text(0, 4) === 'wOFF' || text(0, 4) === 'wOF2' || text(0, 4) === 'OTTO' || starts(0, 1, 0, 0)) return 'font';
  if (named === 'archive') return named;
  if (head.includes(0)) return 'unsupported';
  return previewKindFor(path);
}

import { describe, expect, it } from 'vitest';
import { decodePreviewText } from './decode-text';
describe('preview text decoding', () => {
  it('reads UTF-8, BOM-marked UTF-16 in either order and GBK Chinese', () => {
    expect(decodePreviewText(new TextEncoder().encode('Trylo 中文'))).toBe('Trylo 中文');
    expect(decodePreviewText(Uint8Array.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]))).toBe('中文');
    expect(decodePreviewText(Uint8Array.from([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87]))).toBe('中文');
    expect(decodePreviewText(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe('中文');
  });
});

import { describe, expect, it } from 'vitest';
import { mediaRange } from '../../../vite-plugins/preview/media';
describe('media HTTP range handling', () => {
  it('supports seeking, open ended ranges, suffix ranges and clamps the end', () => {
    expect(mediaRange(undefined, 100)).toBeNull();
    expect(mediaRange('bytes=20-29', 100)).toEqual({ start: 20, end: 29 });
    expect(mediaRange('bytes=20-', 100)).toEqual({ start: 20, end: 99 });
    expect(mediaRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(mediaRange('bytes=0-1000', 100)).toEqual({ start: 0, end: 99 });
  });
  it('rejects invalid, multipart, empty and unsatisfiable ranges', () => {
    for (const header of ['bytes=100-', 'bytes=50-20', 'bytes=-0', 'bytes=-', 'bytes=1-2,3-4', 'other=0-2']) expect(() => mediaRange(header, 100)).toThrow();
    expect(() => mediaRange('bytes=0-', 0)).toThrow();
  });
});

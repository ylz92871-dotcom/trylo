import { expect, it } from 'vitest';
import { mediaByteRanges, mediaPlaylist, mediaSegmentCount, mediaStreamArguments, parseMediaInfo } from './media-playlist';
it('keeps the entire source timeline and its short final segment', () => {
  const manifest = mediaPlaylist(14);
  expect(manifest.match(/#EXTINF:/g)).toHaveLength(3);
  expect(manifest).toContain('#EXTINF:2.000000,\nsegments/2.ts');
  expect(manifest).not.toContain('#EXT-X-DISCONTINUITY');
  expect(manifest).toContain('#EXT-X-ENDLIST');
  const args = mediaStreamArguments(2, { duration: 14, videoIndex: 0, audioIndex: 1 }, 'owned/index.m3u8');
  expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '12']);
  expect(args).not.toContain('-t');
  expect(args.slice(args.indexOf('-output_ts_offset'), args.indexOf('-output_ts_offset') + 2)).toEqual(['-output_ts_offset', '13']);
  expect(args).toContain('fd:'); expect(args).not.toContain('file:');
  expect(() => mediaStreamArguments(3, { duration: 14 }, 'owned/index.m3u8')).toThrow();
  expect(() => mediaPlaylist(Infinity)).toThrow();
  expect(mediaSegmentCount(12.03)).toBe(2);
  expect(mediaPlaylist(12.03)).toContain('#EXTINF:6.030000,\nsegments/1.ts');
});
it('excludes album artwork, validates media duration, and checks stdout byte-range ownership', () => {
  expect(parseMediaInfo({ format: { duration: '14' }, streams: [{ index: 0, codec_type: 'video', disposition: { attached_pic: 1 } }, { index: 1, codec_type: 'audio' }] })).toEqual({ duration: 14, audioIndex: 1 });
  expect(() => parseMediaInfo({ format: { duration: 'N/A' }, streams: [] })).toThrow();
  expect(mediaByteRanges('#EXT-X-BYTERANGE:188@0\n#EXT-X-BYTERANGE:376@188\n')).toHaveLength(2);
  expect(() => mediaByteRanges('#EXT-X-BYTERANGE:188@42\n')).toThrow();
  const silent = mediaStreamArguments(0, { duration: 2, videoIndex: 0 }, 'owned/index.m3u8');
  expect(silent).toContain('-an'); expect(silent).not.toContain('-af');
});

import { expect, it } from 'vitest';
import { mediaTime } from './MediaTransport';
it('shows real duration units and a readable unknown-duration state', () => {
  expect(mediaTime(0)).toBe('0:00'); expect(mediaTime(59.9)).toBe('0:59');
  expect(mediaTime(3661)).toBe('1:01:01');
  expect(mediaTime(Number.NaN)).toBe('—:—'); expect(mediaTime(Infinity)).toBe('—:—');
});

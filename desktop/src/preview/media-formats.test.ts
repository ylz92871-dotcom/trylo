import { expect, it } from 'vitest';
import { MEDIA_FORMATS, mediaFormatFor } from './media-formats';
import { previewKindFor, previewKindNeedsBytes } from './formats';

it('routes common media containers consistently while reserving ambiguous source extensions', () => {
  for (const [extension, format] of Object.entries(MEDIA_FORMATS)) {
    expect(mediaFormatFor(`D:\\clips\\sample.${extension.toUpperCase()}`)).toEqual(format);
    if (format.ambiguous) { expect(previewKindFor(`source.${extension}`)).toBe('code'); continue; }
    const kind = previewKindFor(`sample.${extension}`);
    expect(kind, extension).toBe(format.kind); expect(previewKindNeedsBytes(kind)).toBe(true);
  }
});

// Trylo Desktop — gerberSvg unit tests. Inline Gerber, no fixtures.

import { describe, expect, it } from 'vitest';
import { gerberToSvgString } from './gerberSvg';

const SIMPLE_GERBER = `G04 single trace*
%FSLAX24Y24*%
%MOMM*%
%ADD10C,1.0*%
D10*
X0Y0D02*
X1000000Y0D01*
M02*
`;

describe('gerberToSvgString', () => {
  it('converts a minimal gerber file to svg', async () => {
    const svg = await gerberToSvgString(SIMPLE_GERBER, 'test-trace');
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox');
  });

  it('tolerates garbage input with an empty drawing', async () => {
    // gerber-to-svg is lenient: non-gerber input resolves to an (empty)
    // SVG rather than rejecting. Real failures (I/O, limits) reject.
    const svg = await gerberToSvgString('not gerber {{{', 'bad');
    expect(svg).toContain('<svg');
  });

  it('rejects oversized input without parsing', async () => {
    await expect(gerberToSvgString('X'.repeat(1024 * 1024 + 1), 'big')).rejects.toThrow(
      /too large/,
    );
  });
});

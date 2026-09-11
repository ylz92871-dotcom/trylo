// Trylo Desktop — dxfSvg unit tests. Inline DXF, no fixtures.

import { describe, expect, it } from 'vitest';
import { dxfToSvg } from './dxfSvg';

const HEADER = `0
SECTION
2
ENTITIES
`;
const FOOTER = `0
ENDSEC
0
EOF
`;

function dxf(...bodies: string[]): string {
  // Bodies already end in a newline; joining with another one would
  // insert a blank line and shift every group-code pair out of phase.
  return HEADER + bodies.join('') + FOOTER;
}

const LINE = `0
LINE
8
0
10
0.0
20
0.0
30
0.0
11
10.0
21
5.0
31
0.0
`;

const CIRCLE = `0
CIRCLE
8
0
10
5.0
20
5.0
30
0.0
40
2.0
`;

describe('dxfToSvg', () => {
  it('renders line and circle entities with a fitted viewBox', () => {
    const result = dxfToSvg(dxf(LINE, CIRCLE));
    expect(result.rendered).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.svg).toContain('<line');
    expect(result.svg).toContain('<circle');
    expect(result.svg).toContain('viewBox=');
  });

  it('mirrors Y-up into SVG Y-down', () => {
    // Line from (0,0) to (10,5): the SVG end point must be y=-5.
    const result = dxfToSvg(dxf(LINE));
    expect(result.svg).toContain('x2="10" y2="-5"');
  });

  it('draws CCW arcs on the correct half (sweep-flag 0)', () => {
    // A 0→180° DXF arc passes through the TOP in y-up; after the
    // Y-mirror it must pass through the top on screen, which is SVG
    // counter-clockwise (sweep 0). Sweep 1 renders the wrong half.
    const arc = `0
ARC
8
0
10
50.0
20
25.0
30
0.0
40
10.0
50
0.0
51
180.0
`;
    const result = dxfToSvg(dxf(arc));
    expect(result.rendered).toBe(1);
    expect(result.svg).toContain('M 60 -25 A 10 10 0 0 0 40 -25');
  });

  it('does not flag straight polylines as approximated', () => {
    const pline = `0
LWPOLYLINE
8
0
90
2
70
0
10
0.0
20
0.0
10
10.0
20
0.0
`;
    const result = dxfToSvg(dxf(pline));
    expect(result.rendered).toBe(1);
    expect(result.approximated).toBe(false);
  });

  it('counts unsupported entities instead of dropping them silently', () => {
    const insert = `0
INSERT
8
0
2
MYBLOCK
`;
    const result = dxfToSvg(dxf(LINE, insert));
    expect(result.rendered).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.svg).not.toContain('INSERT');
  });

  it('returns empty svg for garbage input', () => {
    const result = dxfToSvg('this is not dxf {{{');
    expect(result.svg).toBe('');
    expect(result.rendered).toBe(0);
  });

  it('returns empty svg for oversized input', () => {
    const result = dxfToSvg('0\n'.repeat(2 * 1024 * 1024 + 1));
    expect(result.svg).toBe('');
  });
});

// Trylo Desktop — single-file Gerber/drill → SVG (pure promise).
//
// gerber-to-svg (MIT, tracespace) parses RS-274X + Excellon drill and
// returns a finished SVG string via callback. This module is the only
// place that touches the callback shape; the React side awaits a
// promise. Cap the input — a multi-MB copper pour has no business in
// a 480px rail.

import gerberToSvg from 'gerber-to-svg';

const MAX_CHARS = 1024 * 1024;

/** Convert one Gerber/drill file to an SVG string. Rejects on error. */
export function gerberToSvgString(source: string, id: string): Promise<string> {
  if (source.length > MAX_CHARS) {
    return Promise.reject(new Error('file is too large for in-app preview.'));
  }
  return new Promise((resolve, reject) => {
    gerberToSvg(source, id, (error: Error, svg: string) => {
      if (error) reject(error);
      else resolve(svg);
    });
  });
}

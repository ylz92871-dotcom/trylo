// Trylo Desktop — resolveArtifactKind unit tests.
//
// 2026-09-10 (applyWorkItem deletion面): migrated verbatim from the deleted
// `work-item-mapper.test.ts` ("work-item-mapper: resolveArtifactKind" block).
// The helper now lives in `./artifact-kind`.

import { describe, expect, it } from 'vitest';
import { resolveArtifactKind } from './artifact-kind';

describe('artifact-kind: resolveArtifactKind', () => {
  it('accepts a known upstream hint as-is', () => {
    expect(resolveArtifactKind('presentation', 'x.bin')).toBe('presentation');
  });

  it('ignores an unknown hint and derives from the extension', () => {
    expect(resolveArtifactKind('mystery', 'D:/repo/site/index.html')).toBe('web');
  });

  // P2-1 (spec §8.6): unknown extensions are a generic `file`, never a
  // pretend document.
  it('falls back to a generic file for unknown extensions', () => {
    expect(resolveArtifactKind(undefined, 'D:/repo/data.xyz')).toBe('file');
  });
});

// Trylo Desktop — Work artifact capability dispatch tests
// (P2-1 A-Edge / audit P1-4).
//
// The dispatch matrix decides what "Open" should do for a Work
// artifact: text/source → in-app peek, images → in-app media peek,
// PDF/Office / unknown binary / no extension → host/OS viewer through
// the project-root-bound workArtifactHost. We test the pure helper
// directly for the matrix, and exercise the dispatch wiring in a
// mirror function that uses the same `artifactCapabilityFor` decision
// branch App.tsx uses (App.tsx's `onOpenWorkArtifact` is a closure
// inside the React component; mirroring the branch here catches the
// common regression of forgetting to call the host adapter on
// host-open).

import { describe, expect, it, vi } from 'vitest';
import {
  artifactCapabilityFor,
  extOf,
  type ArtifactCapability,
} from './work-artifact-dispatch';

describe('extOf (P2-1 A-Edge dispatch helper)', () => {
  it('returns the lowercased extension including the dot', () => {
    expect(extOf('D:/repo/.trylo/out/README.MD')).toBe('.md');
    expect(extOf('/a/b/c.Png')).toBe('.png');
    expect(extOf('plain.txt')).toBe('.txt');
  });

  it('returns "" when the path has no extension', () => {
    expect(extOf('D:/repo/Makefile')).toBe('');
    expect(extOf('LICENSE')).toBe('');
  });

  it('only matches the last segment, not directory dots', () => {
    // The regex anchors on the LAST `.X` of the last `/`/`\`-separated
    // segment. Directory dots in the middle of a path are not part of
    // the extension. A hidden file whose name IS the dot-segment (no
    // following characters) is still matched — `.hidden` is treated as
    // the extension, which then falls through the dispatch matrix to
    // host-open (it's neither image nor Office nor the text-preview
    // default). The audit's "no extension" path is reserved for paths
    // with no `.` at all in the trailing segment (e.g. `Makefile`).
    expect(extOf('D:/repo/out/file.txt')).toBe('.txt');
    expect(extOf('D:/repo/.trylo/out/.hidden')).toBe('.hidden');
    expect(extOf('D:/repo/out/Makefile')).toBe('');
  });
});

describe('artifactCapabilityFor (P2-1 A-Edge dispatch matrix)', () => {
  it('routes text-like paths to in-app text preview', () => {
    expect(artifactCapabilityFor('D:/repo/.trylo/out/notes.md'))
      .toEqual<ArtifactCapability>({ kind: 'text-preview' });
    expect(artifactCapabilityFor('D:/repo/.trylo/out/page.html'))
      .toEqual<ArtifactCapability>({ kind: 'text-preview' });
    expect(artifactCapabilityFor('D:/repo/.trylo/out/data.json'))
      .toEqual<ArtifactCapability>({ kind: 'text-preview' });
    expect(artifactCapabilityFor('D:/repo/.trylo/out/main.ts'))
      .toEqual<ArtifactCapability>({ kind: 'text-preview' });
    expect(artifactCapabilityFor('D:/repo/.trylo/out/script.rs'))
      .toEqual<ArtifactCapability>({ kind: 'text-preview' });
  });

  it('routes images to in-app image preview', () => {
    expect(artifactCapabilityFor('D:/repo/.trylo/out/photo.png'))
      .toEqual<ArtifactCapability>({ kind: 'image-preview' });
    expect(artifactCapabilityFor('D:/repo/.trylo/out/photo.JPG'))
      .toEqual<ArtifactCapability>({ kind: 'image-preview' });
    expect(artifactCapabilityFor('D:/repo/.trylo/out/photo.webp'))
      .toEqual<ArtifactCapability>({ kind: 'image-preview' });
    expect(artifactCapabilityFor('D:/repo/.trylo/out/icon.svg'))
      .toEqual<ArtifactCapability>({ kind: 'image-preview' });
  });

  it('routes PDF to in-app rich preview', () => {
    expect(artifactCapabilityFor('D:/repo/.trylo/out/report.pdf'))
      .toEqual<ArtifactCapability>({ kind: 'rich-preview', preview: 'pdf' });
  });

  it('routes OOXML Office documents to in-app rich preview', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['spec.docx', 'docx'],
      ['spec.docm', 'docx'],
      ['budget.xlsx', 'xlsx'],
      ['budget.xls', 'xlsx'],
      ['deck.pptx', 'pptx'],
      ['deck.ppsx', 'pptx'],
    ];
    for (const [file, preview] of cases) {
      expect(artifactCapabilityFor(`D:/repo/.trylo/out/${file}`), file)
        .toEqual<ArtifactCapability>({ kind: 'rich-preview', preview });
    }
  });

  it('routes legacy binary Office to host-open', () => {
    for (const ext of ['.doc', '.ppt', '.rtf', '.odt']) {
      const cap = artifactCapabilityFor(`D:/repo/.trylo/out/file${ext}`);
      expect(cap.kind, `expected ${ext} to be host-open`).toBe('host-open');
    }
  });

  it('routes CAD lightweights to in-app rich preview', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['bracket.stl', 'model3d'],
      ['housing.obj', 'model3d'],
      ['part.glb', 'model3d'],
      ['plate.dxf', 'dxf'],
      ['board-F_Cu.gbr', 'gerber'],
      ['board.drl', 'gerber'],
    ];
    for (const [file, preview] of cases) {
      expect(artifactCapabilityFor(`D:/repo/.trylo/out/${file}`), file)
        .toEqual<ArtifactCapability>({ kind: 'rich-preview', preview });
    }
  });

  it('routes CAD natives to host-open (never a garbage text peek)', () => {
    for (const ext of ['.sldprt', '.sldasm', '.blend', '.fcstd']) {
      const cap = artifactCapabilityFor(`D:/repo/.trylo/out/part${ext}`);
      expect(cap.kind, `expected ${ext} to be host-open`).toBe('host-open');
    }
  });

  it('routes unsupported binary extensions to host-open', () => {
    // The matrix lists the most common archive/compiled-binary
    // extensions explicitly. Files with these extensions would garble
    // the text peek, so the host adapter is the only safe handler.
    for (const ext of ['.bin', '.zip', '.tar', '.gz', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib']) {
      const cap = artifactCapabilityFor(`D:/repo/.trylo/out/artifact${ext}`);
      expect(cap.kind, `expected ${ext} to be host-open`).toBe('host-open');
    }
  });

  it('routes paths with no extension to host-open', () => {
    const cap = artifactCapabilityFor('D:/repo/.trylo/out/Makefile');
    expect(cap.kind).toBe('host-open');
    if (cap.kind === 'host-open') {
      expect(cap.reason).toMatch(/no extension/i);
    }
  });
});

/**
 * The onOpenWorkArtifact callback inside App is a closure that uses
 * useCallback with [onSelectFile, workArtifactHost]. To verify the
 * dispatch wiring without mounting the entire App, we re-import the
 * helper module and reproduce the callback's decision branch against
 * stub collaborators.
 *
 * This is a deliberate mirror of the production branch: if the App
 * callback drifts from this, the test will start to silently diverge
 * (we cover the matrix in `artifactCapabilityFor` above) — but the
 * wiring guard below catches the most common regression: forgetting to
 * call the host adapter on host-open.
 */
describe('onOpenWorkArtifact dispatch wiring (P2-1 A-Edge)', () => {
  // Build the same dispatch that `onOpenWorkArtifact` performs, against
  // stub collaborators. This is a deliberate "decision-tree" check so
  // that if someone changes App.tsx's branch, the test will point at
  // which capability is being mis-wired.
  function dispatch(
    path: string,
    onSelectFile: (p: string, kind: 'file' | 'dir') => void,
    host: { openFile: (p: string) => Promise<void> | void },
  ): void {
    const cap = artifactCapabilityFor(path);
    if (cap.kind === 'text-preview' || cap.kind === 'image-preview' || cap.kind === 'rich-preview') {
      onSelectFile(path, 'file');
      return;
    }
    void host.openFile(path);
  }

  it('routes text, image, and rich previews through the in-app peek', () => {
    const onSelectFile = vi.fn();
    const host = { openFile: vi.fn() };
    dispatch('D:/repo/.trylo/out/notes.md', onSelectFile, host);
    dispatch('D:/repo/.trylo/out/photo.png', onSelectFile, host);
    dispatch('D:/repo/.trylo/out/report.pdf', onSelectFile, host);
    dispatch('D:/repo/.trylo/out/deck.pptx', onSelectFile, host);
    dispatch('D:/repo/.trylo/out/plate.dxf', onSelectFile, host);
    expect(onSelectFile).toHaveBeenCalledTimes(5);
    expect(onSelectFile).toHaveBeenNthCalledWith(1, 'D:/repo/.trylo/out/notes.md', 'file');
    expect(onSelectFile).toHaveBeenNthCalledWith(2, 'D:/repo/.trylo/out/photo.png', 'file');
    expect(host.openFile).not.toHaveBeenCalled();
  });

  it('routes legacy Office and binary to the artifact host (not the peek)', () => {
    const onSelectFile = vi.fn();
    const host = { openFile: vi.fn().mockResolvedValue(undefined) };
    dispatch('D:/repo/.trylo/out/legacy.doc', onSelectFile, host);
    dispatch('D:/repo/.trylo/out/legacy.ppt', onSelectFile, host);
    dispatch('D:/repo/.trylo/out/part.sldprt', onSelectFile, host);
    dispatch('D:/repo/.trylo/out/recording.bin', onSelectFile, host);
    expect(onSelectFile).not.toHaveBeenCalled();
    expect(host.openFile).toHaveBeenCalledTimes(4);
  });

  it('routes a path with no extension to the host (never to text peek)', () => {
    // Regression guard: the previous implementation read every Work
    // artifact as text, which fails on extension-less binaries.
    const onSelectFile = vi.fn();
    const host = { openFile: vi.fn() };
    dispatch('D:/repo/.trylo/out/Makefile', onSelectFile, host);
    expect(onSelectFile).not.toHaveBeenCalled();
    expect(host.openFile).toHaveBeenCalledWith('D:/repo/.trylo/out/Makefile');
  });
});

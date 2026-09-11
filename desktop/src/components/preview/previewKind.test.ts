// Trylo Desktop — previewKind unit tests. Pure dispatch, no IO.

import { describe, expect, it } from 'vitest';
import { previewExtOf, previewKindFor, previewKindNeedsBytes } from './previewKind';

describe('previewExtOf', () => {
  it('lowercases the trailing extension', () => {
    expect(previewExtOf('D:/repo/notes.MD')).toBe('.md');
    expect(previewExtOf('/a/b/photo.JPG')).toBe('.jpg');
  });

  it('returns "" when there is no extension', () => {
    expect(previewExtOf('D:/repo/Makefile')).toBe('');
  });
});

describe('previewKindFor', () => {
  it('routes markdown to the rich markdown view', () => {
    expect(previewKindFor('D:/repo/notes.md')).toBe('markdown');
    expect(previewKindFor('D:/repo/notes.markdown')).toBe('markdown');
  });

  it('routes html to the sandboxed page view', () => {
    expect(previewKindFor('D:/repo/.trylo/out/landing-page.html')).toBe('html');
    expect(previewKindFor('D:/repo/page.htm')).toBe('html');
  });

  it('routes csv/tsv to the table view', () => {
    expect(previewKindFor('D:/repo/.trylo/out/budget-2026.csv')).toBe('csv');
    expect(previewKindFor('D:/repo/data.tsv')).toBe('csv');
  });

  it('routes every dispatch image extension to the image view', () => {
    // Must stay in sync with IMAGE_EXTENSIONS in work-artifact-dispatch.
    const images = [
      'a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'a.gif', 'a.bmp',
      'a.svg', 'a.avif', 'a.heic', 'a.heif', 'a.tif', 'a.tiff', 'a.ico',
    ];
    for (const name of images) {
      expect(previewKindFor(`D:/repo/out/${name}`), name).toBe('image');
    }
  });

  it('falls back to text for code and unclaimed types', () => {
    expect(previewKindFor('D:/repo/main.ts')).toBe('text');
    expect(previewKindFor('D:/repo/data.json')).toBe('text');
    expect(previewKindFor('D:/repo/Makefile')).toBe('text');
    // Deliberately unclaimed: legacy binary Office, CAD natives.
    expect(previewKindFor('D:/repo/legacy.doc')).toBe('text');
    expect(previewKindFor('D:/repo/legacy.ppt')).toBe('text');
    expect(previewKindFor('D:/repo/part.sldprt')).toBe('text');
    expect(previewKindFor('D:/repo/board.kicad_pcb')).toBe('text');
  });

  it('routes office deliverables to their renderers', () => {
    expect(previewKindFor('D:/repo/report.pdf')).toBe('pdf');
    expect(previewKindFor('D:/repo/contract.docx')).toBe('docx');
    expect(previewKindFor('D:/repo/contract.docm')).toBe('docx');
    expect(previewKindFor('D:/repo/budget.xlsx')).toBe('xlsx');
    expect(previewKindFor('D:/repo/budget.xls')).toBe('xlsx');
    expect(previewKindFor('D:/repo/deck.pptx')).toBe('pptx');
  });

  it('routes CAD lightweights to their viewers', () => {
    expect(previewKindFor('D:/repo/bracket.stl')).toBe('model3d');
    expect(previewKindFor('D:/repo/assembly.obj')).toBe('model3d');
    expect(previewKindFor('D:/repo/part.glb')).toBe('model3d');
    expect(previewKindFor('D:/repo/plate.dxf')).toBe('dxf');
    expect(previewKindFor('D:/repo/board-F_Cu.gbr')).toBe('gerber');
    expect(previewKindFor('D:/repo/board.drl')).toBe('gerber');
  });
});

describe('previewKindNeedsBytes', () => {
  it('marks binary renderers so the text read is skipped', () => {
    for (const kind of ['image', 'pdf', 'docx', 'xlsx', 'pptx', 'model3d'] as const) {
      expect(previewKindNeedsBytes(kind), kind).toBe(true);
    }
  });

  it('keeps text-based renderers on the UTF-8 path', () => {
    for (const kind of ['markdown', 'html', 'csv', 'dxf', 'gerber', 'text'] as const) {
      expect(previewKindNeedsBytes(kind), kind).toBe(false);
    }
  });
});

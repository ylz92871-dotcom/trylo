// Trylo Desktop — remote routing pure-helper tests (P3: read-only
// deliverables). Path guards and mime mapping must stay closed-set: the
// phone can ask for any string, so traversal must be impossible by
// construction here (the gateway and the App authority check again).

import { describe, expect, it } from 'vitest';

import { mimeTypeForArtifactName, sanitizeArtifactRelPath } from './remote-routing';

describe('sanitizeArtifactRelPath', () => {
  it('accepts plain workspace-relative paths', () => {
    expect(sanitizeArtifactRelPath('out/report.docx')).toBe('out/report.docx');
    expect(sanitizeArtifactRelPath('deck.pptx')).toBe('deck.pptx');
  });

  it('rejects traversal, absolutes, and odd segments', () => {
    expect(sanitizeArtifactRelPath('../secret.txt')).toBeNull();
    expect(sanitizeArtifactRelPath('out/../../x')).toBeNull();
    expect(sanitizeArtifactRelPath('/etc/passwd')).toBeNull();
    expect(sanitizeArtifactRelPath('C:/win.ini')).toBeNull();
    expect(sanitizeArtifactRelPath('out\\report.docx')).toBeNull();
    expect(sanitizeArtifactRelPath('out//a.docx')).toBeNull();
    expect(sanitizeArtifactRelPath('')).toBeNull();
    expect(sanitizeArtifactRelPath(null)).toBeNull();
    expect(sanitizeArtifactRelPath('x'.repeat(513))).toBeNull();
  });
});

describe('mimeTypeForArtifactName', () => {
  it('maps known deliverable extensions', () => {
    expect(mimeTypeForArtifactName('a.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(mimeTypeForArtifactName('a.XLSX')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(mimeTypeForArtifactName('a.png')).toBe('image/png');
    expect(mimeTypeForArtifactName('a.md')).toBe('text/markdown');
  });

  it('falls back to octet-stream', () => {
    expect(mimeTypeForArtifactName('a.exe')).toBe('application/octet-stream');
    expect(mimeTypeForArtifactName('noext')).toBe('application/octet-stream');
  });
});

// Trylo Desktop — attachment-utils tests. See v1.16.2.

import { describe, expect, it } from 'vitest';
import {
  attachmentFitsLimits,
  attachmentKind,
  attachmentMediaType,
  attachmentSizeLimit,
  buildAttachmentExcerpt,
  buildAttachmentPromptContext,
  fileSizeFitsLimit,
  MAX_ATTACHMENTS_PER_SESSION,
  MAX_ATTACHMENT_BYTES_OFFICE,
  MAX_ATTACHMENT_BYTES_TEXT,
  MAX_ATTACHMENT_EXCERPT_CHARS,
  newAttachmentId,
  type Attachment,
} from './attachment-utils';

describe('attachmentKind', () => {
  it('classifies office extensions', () => {
    expect(attachmentKind('C:/path/contract.docx')).toBe('office');
    expect(attachmentKind('C:/path/report.xlsx')).toBe('office');
    expect(attachmentKind('C:/path/deck.pptx')).toBe('office');
    expect(attachmentKind('C:/path/spec.pdf')).toBe('office');
  });

  it('classifies image extensions', () => {
    expect(attachmentKind('C:/path/shot.png')).toBe('image');
    expect(attachmentKind('C:/path/photo.jpg')).toBe('image');
    expect(attachmentKind('C:/path/photo.jpeg')).toBe('image');
    expect(attachmentKind('C:/path/anim.webp')).toBe('image');
  });

  it('defaults to text for everything else', () => {
    expect(attachmentKind('C:/path/notes.md')).toBe('text');
    expect(attachmentKind('C:/path/main.ts')).toBe('text');
    expect(attachmentKind('C:/path/Makefile')).toBe('text');
    expect(attachmentKind('C:/path/unknown.xyz')).toBe('text');
  });

  it('is case-insensitive on the extension', () => {
    expect(attachmentKind('C:/path/REPORT.DOCX')).toBe('office');
    expect(attachmentKind('C:/path/Shot.PNG')).toBe('image');
  });
});

describe('attachmentMediaType', () => {
  it('returns the office MIME for office files', () => {
    expect(attachmentMediaType('C:/x.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(attachmentMediaType('C:/x.pdf')).toBe('application/pdf');
  });

  it('returns the image MIME for images', () => {
    expect(attachmentMediaType('C:/x.png')).toBe('image/png');
    expect(attachmentMediaType('C:/x.jpg')).toBe('image/jpeg');
  });

  it('returns empty string for text / unknown', () => {
    expect(attachmentMediaType('C:/x.md')).toBe('');
    expect(attachmentMediaType('C:/x.unknown')).toBe('');
  });
});

describe('attachmentSizeLimit', () => {
  it('returns 1 MB for text', () => {
    expect(attachmentSizeLimit('text')).toBe(MAX_ATTACHMENT_BYTES_TEXT);
  });
  it('returns 25 MB for office', () => {
    expect(attachmentSizeLimit('office')).toBe(MAX_ATTACHMENT_BYTES_OFFICE);
  });
  it('returns 1 MB for image', () => {
    expect(attachmentSizeLimit('image')).toBe(MAX_ATTACHMENT_BYTES_TEXT);
  });
});

describe('fileSizeFitsLimit', () => {
  it('accepts a small text file', () => {
    expect(fileSizeFitsLimit('text', 1000)).toEqual({ ok: true });
  });
  it('rejects a text file over 1 MB', () => {
    const r = fileSizeFitsLimit('text', MAX_ATTACHMENT_BYTES_TEXT + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too large/);
  });
  it('accepts a 20 MB office file', () => {
    expect(fileSizeFitsLimit('office', 20 * 1024 * 1024)).toEqual({ ok: true });
  });
  it('rejects a 60 MB office file', () => {
    // v1.16.2.6: limit bumped to 50 MB. 60 MB > 50 MB → reject.
    const r = fileSizeFitsLimit('office', 60 * 1024 * 1024);
    expect(r.ok).toBe(false);
  });
});

describe('attachmentFitsLimits (count)', () => {
  it('rejects when session already at max', () => {
    const r = attachmentFitsLimits(MAX_ATTACHMENTS_PER_SESSION);
    expect(r.ok).toBe(false);
  });
  it('accepts when below the cap', () => {
    expect(attachmentFitsLimits(MAX_ATTACHMENTS_PER_SESSION - 1)).toEqual({
      ok: true,
    });
    expect(attachmentFitsLimits(0)).toEqual({ ok: true });
  });
});

describe('buildAttachmentExcerpt', () => {
  it('emits an Office label for office kind, ignoring textContent', () => {
    expect(
      buildAttachmentExcerpt('office', 'contract.docx', 'application/pdf', 'should be ignored'),
    ).toBe('Office attachment: contract.docx (application/pdf)');
  });

  it('emits an Image label for image kind', () => {
    expect(buildAttachmentExcerpt('image', 'shot.png', 'image/png', null))
      .toBe('Image attachment: shot.png (image/png)');
  });

  it('omits the mediaType when empty', () => {
    expect(buildAttachmentExcerpt('image', 'shot.png', '', null))
      .toBe('Image attachment: shot.png');
  });

  it('truncates long text content to MAX_ATTACHMENT_EXCERPT_CHARS + ellipsis', () => {
    // Mirrors the old code's shortText behaviour:
    // truncate to N chars then append the ellipsis, so
    // the final length is N + 1.
    const long = 'x'.repeat(500);
    const excerpt = buildAttachmentExcerpt('text', 'notes.md', '', long);
    expect(excerpt.length).toBe(MAX_ATTACHMENT_EXCERPT_CHARS + 1);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('returns short text as-is when within the cap', () => {
    expect(buildAttachmentExcerpt('text', 'a.md', '', 'hello world'))
      .toBe('hello world');
  });

  it('returns an empty-text label when textContent is null', () => {
    expect(buildAttachmentExcerpt('text', 'empty.md', '', null))
      .toBe('Text attachment: empty.md (empty)');
  });
});

describe('buildAttachmentPromptContext', () => {
  it('returns "" for an empty list', () => {
    expect(buildAttachmentPromptContext([])).toBe('');
  });

  it('lists each attachment with kind label, size, and path', () => {
    const attachments: Attachment[] = [
      {
        id: 'a1',
        kind: 'office',
        name: 'contract.docx',
        path: 'C:/ws/contract.docx',
        size: 15_000,
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        excerpt: 'Office attachment: contract.docx (application/...)',
        addedAt: 1,
      },
      {
        id: 'a2',
        kind: 'text',
        name: 'notes.md',
        path: 'C:/ws/notes.md',
        size: 4_000,
        mediaType: '',
        excerpt: 'first 220 chars of notes',
        addedAt: 2,
      },
    ];
    const ctx = buildAttachmentPromptContext(attachments);
    expect(ctx).toContain('[Session attachments]');
    expect(ctx).toContain('- contract.docx [Office');
    expect(ctx).toContain('at C:/ws/contract.docx');
    expect(ctx).toContain('excerpt: Office attachment: contract.docx');
    expect(ctx).toContain('- notes.md [Text, 3.9KB]');
    expect(ctx).toContain('at C:/ws/notes.md');
    expect(ctx).toContain('excerpt: first 220 chars of notes');
  });
});

describe('newAttachmentId', () => {
  it('returns ids in the attachment_<ts>_<rand> shape', () => {
    const id = newAttachmentId();
    expect(id).toMatch(/^attachment_[a-z0-9]+_[a-z0-9]+$/);
  });
  it('returns different ids on consecutive calls', () => {
    expect(newAttachmentId()).not.toBe(newAttachmentId());
  });
});

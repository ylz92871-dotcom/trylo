import { expect, it, vi } from 'vitest';
import { loadPreviewFile } from './read-file';
import { sniffPreviewKind } from '../../preview/sniff';

it('distinguishes TypeScript from MPEG-TS and never decodes a recording as text', async () => {
  const head = new Uint8Array(188 * 4);
  for (let index = 0; index < 4; index++) { head[index * 188] = 0x47; head[index * 188 + 3] = 0x10; }
  const text = vi.fn(async () => 'export const answer = 42');
  expect(await loadPreviewFile('clip.ts', 'D:/repo', { head: async () => head, text })).toEqual({ resolvedKind: 'video', content: '' });
  expect(text).not.toHaveBeenCalled();
  expect(await loadPreviewFile('module.ts', 'D:/repo', { head: async () => new TextEncoder().encode('export const answer = 42'), text })).toEqual({ resolvedKind: 'code', content: 'export const answer = 42' });
});
it('opens extensionless scripts and misnamed documents using bounded header evidence', async () => {
  expect(await loadPreviewFile('script', 'D:/repo', { head: async () => new TextEncoder().encode('#!/usr/bin/env python3'), text: async () => '#!/usr/bin/env python3\nprint(42)' })).toMatchObject({ resolvedKind: 'code' });
  const text = vi.fn(async () => 'must not decode a PDF');
  expect(await loadPreviewFile('report.download', 'D:/repo', { head: async () => new TextEncoder().encode('%PDF-1.7'), text })).toEqual({ resolvedKind: 'pdf', content: '' });
  expect(text).not.toHaveBeenCalled();
  expect(sniffPreviewKind('script', new Uint8Array([255, 254, 97, 0]))).toBe('text');
  expect(sniffPreviewKind('unknown', new Uint8Array([1, 0, 2]))).toBe('unsupported');
});

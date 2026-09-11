// PR-4 (spec §7 / §14.3): structured tool-result content parsing matrix.
//
// Shapes verified against the Trylo CLI's MCP client module
// `transformResultContent` (the Anthropic wire shape the CLI emits for MCP
// images) plus the flat MCP shapes accepted defensively, and the persisted
// whitelist that keeps base64 out of the session JSON (§15.2 breaker).

import { describe, expect, it } from 'vitest';
import {
  normalizePersistedToolResultContent,
  parseMcpMetaStructured,
  parseToolResultBlock,
  summarizeToolResultContent,
  toPersistedToolResultContent,
  type BinaryRef,
} from './tool-result-content';

const SAMPLE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const REF: BinaryRef = {
  id: 'bin-abc',
  storage: 'ephemeral-tool-cache',
  path: 'C:/Users/x/AppData/tool-cache/ab/abc123.png',
  mimeType: 'image/png',
  size: 1024,
  sha256: 'a'.repeat(64),
};

describe('parseToolResultBlock — text', () => {
  it('parses a text block and rejects non-string text', () => {
    expect(parseToolResultBlock({ type: 'text', text: 'hello' })).toEqual({ type: 'text', text: 'hello' });
    expect(parseToolResultBlock({ type: 'text', text: 42 })).toBeNull();
    expect(parseToolResultBlock(null)).toBeNull();
    expect(parseToolResultBlock('text')).toBeNull();
  });
});

describe('parseToolResultBlock — image shapes', () => {
  it('parses the Anthropic base64-source shape the CLI emits', () => {
    const block = parseToolResultBlock({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: SAMPLE_BASE64 },
    });
    expect(block).toEqual({ type: 'image', data: SAMPLE_BASE64, mimeType: 'image/png' });
  });

  it('parses the flat MCP shape defensively', () => {
    const block = parseToolResultBlock({ type: 'image', data: SAMPLE_BASE64, mimeType: 'image/jpeg' });
    expect(block).toEqual({ type: 'image', data: SAMPLE_BASE64, mimeType: 'image/jpeg' });
  });

  it('rejects an image with no recoverable data', () => {
    expect(parseToolResultBlock({ type: 'image', source: { type: 'url', url: 'https://x' } })).toBeNull();
    expect(parseToolResultBlock({ type: 'image', data: '' })).toBeNull();
  });
});

describe('parseToolResultBlock — audio / resource / resource_link', () => {
  it('parses a flat MCP audio block', () => {
    expect(parseToolResultBlock({ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }))
      .toEqual({ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' });
  });

  it('parses a nested MCP resource with text (stays text, no binary)', () => {
    expect(parseToolResultBlock({
      type: 'resource',
      resource: { uri: 'file:///tmp/a.txt', mimeType: 'text/plain', text: 'contents' },
    })).toEqual({ type: 'resource', uri: 'file:///tmp/a.txt', mimeType: 'text/plain', text: 'contents' });
  });

  it('parses a nested MCP resource with a blob as a TRANSIENT binary block', () => {
    expect(parseToolResultBlock({
      type: 'resource',
      resource: { uri: 'file:///tmp/a.png', mimeType: 'image/png', blob: SAMPLE_BASE64 },
    })).toEqual({ type: 'resource', uri: 'file:///tmp/a.png', mimeType: 'image/png', blob: SAMPLE_BASE64 });
  });

  it('parses resource_link with name fallback to uri', () => {
    expect(parseToolResultBlock({ type: 'resource_link', uri: 'https://x/y', name: 'doc' }))
      .toEqual({ type: 'resource_link', uri: 'https://x/y', name: 'doc' });
    expect(parseToolResultBlock({ type: 'resource_link', uri: 'https://x/y' }))
      .toEqual({ type: 'resource_link', uri: 'https://x/y', name: 'https://x/y' });
  });

  it('rejects a resource without a uri', () => {
    expect(parseToolResultBlock({ type: 'resource', resource: { text: 'x' } })).toBeNull();
  });
});

describe('parseMcpMetaStructured (CLI mcpMeta ride-along, client.ts:1899-1905)', () => {
  it('wraps structuredContent into a structured block', () => {
    expect(parseMcpMetaStructured({ structuredContent: { rows: 3 } }))
      .toEqual({ type: 'structured', value: { rows: 3 } });
  });

  it('returns null without structuredContent and for malformed meta', () => {
    expect(parseMcpMetaStructured({ _meta: { x: 1 } })).toBeNull();
    expect(parseMcpMetaStructured('nope')).toBeNull();
    expect(parseMcpMetaStructured(undefined)).toBeNull();
  });
});

describe('summarizeToolResultContent — output text never carries base64', () => {
  it('joins text blocks and bracket-notes binary ones', () => {
    const summary = summarizeToolResultContent([
      { type: 'text', text: 'shot taken' },
      { type: 'image', data: SAMPLE_BASE64, mimeType: 'image/png' },
      { type: 'resource_link', uri: 'https://x', name: 'n' },
    ]);
    expect(summary).toBe('shot taken\n[image]\n[resource link: n] https://x');
    expect(summary).not.toContain('iVBOR');
  });
});

describe('toPersistedToolResultContent — the §15.2 base64 breaker', () => {
  it('keeps resolved blocks untouched', () => {
    const persisted = toPersistedToolResultContent([
      { type: 'text', text: 'done' },
      { type: 'image', ref: REF },
    ]);
    expect(persisted).toEqual([{ type: 'text', text: 'done' }, { type: 'image', ref: REF }]);
  });

  it('drops raw base64 blocks and replaces them with a notice', () => {
    const persisted = toPersistedToolResultContent([
      { type: 'image', data: SAMPLE_BASE64, mimeType: 'image/png' },
    ]);
    expect(persisted).toEqual([{ type: 'text', text: '[image not cached — dropped]' }]);
    expect(JSON.stringify(persisted)).not.toContain('iVBOR');
  });

  it('strips blob resources but keeps the uri metadata', () => {
    const persisted = toPersistedToolResultContent([
      { type: 'resource', uri: 'file:///a.bin', mimeType: 'image/png', blob: SAMPLE_BASE64 },
    ]);
    expect(persisted).toEqual([{
      type: 'resource',
      uri: 'file:///a.bin',
      mimeType: 'image/png',
      text: '[binary resource content removed from the session record]',
    }]);
    expect(JSON.stringify(persisted)).not.toContain('iVBOR');
  });

  it('truncates base64-looking text', () => {
    const persisted = toPersistedToolResultContent([
      { type: 'text', text: SAMPLE_BASE64.repeat(40) },
    ]);
    expect(persisted?.[0]).toEqual({ type: 'text', text: '[binary content removed from the session record]' });
  });

  it('returns undefined for empty input', () => {
    expect(toPersistedToolResultContent(undefined)).toBeUndefined();
    expect(toPersistedToolResultContent([])).toBeUndefined();
  });
});

describe('normalizePersistedToolResultContent — history load whitelist', () => {
  it('round-trips a valid persisted set', () => {
    const value = [
      { type: 'text', text: 'ok' },
      { type: 'image', ref: REF, alt: 'shot' },
      { type: 'resource_link', uri: 'https://x', name: 'n' },
      { type: 'structured', value: { a: 1 } },
    ];
    expect(normalizePersistedToolResultContent(value)).toEqual(value);
  });

  it('drops blobs, invalid refs and unknown block types', () => {
    const value = [
      { type: 'image', blob: SAMPLE_BASE64 },
      { type: 'image', ref: { ...REF, sha256: 'short' } },
      { type: 'image', ref: { ...REF, storage: 'unknown-storage' } },
      { type: 'resource', uri: 'file:///a', blob: SAMPLE_BASE64 },
      { type: 'mystery', x: 1 },
      { type: 'text' },
    ];
    expect(normalizePersistedToolResultContent(value)).toBeUndefined();
  });

  it('a valid-looking ref OUTSIDE the cache root survives normalize but is rejected at READ time (store containment)', () => {
    const value = [{ type: 'image', ref: { ...REF, path: 'C:/Windows/system32/evil.png' } }];
    const out = normalizePersistedToolResultContent(value);
    expect(out).toBeDefined();
  });

  it('rejects a ref with a traversal path (hand-edited history)', () => {
    const value = [{ type: 'image', ref: { ...REF, path: 'C:/data/../../evil.png' } }];
    expect(normalizePersistedToolResultContent(value)).toBeUndefined();
  });

  // PR-4 audit (2026-09-01): `toPersistedToolResultContent` keeps a
  // URI-only resource, but the load-side whitelist used to drop it — the
  // chip vanished after a reload (§13 PR-4 「刷新后 metadata 可复原」).
  it('keeps a URI-only resource (no text, no cached bytes) across a reload', () => {
    const value = [{ type: 'resource', uri: 'file:///report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }];
    expect(normalizePersistedToolResultContent(value)).toEqual(value);
  });

  it('round-trips a URI-only resource through persist → normalize', () => {
    const persisted = toPersistedToolResultContent([{ type: 'resource', uri: 'file:///a.docx', mimeType: 'application/msword' }]);
    expect(normalizePersistedToolResultContent(persisted)).toEqual(persisted);
  });

  it('returns undefined for non-arrays', () => {
    expect(normalizePersistedToolResultContent('x')).toBeUndefined();
    expect(normalizePersistedToolResultContent(undefined)).toBeUndefined();
  });
});

// Trylo Desktop — csvParse unit tests. Pure parser, no IO.

import { describe, expect, it } from 'vitest';
import { delimiterFor, parseDelimited } from './csvParse';

describe('parseDelimited', () => {
  it('parses simple rows', () => {
    const parsed = parseDelimited('a,b,c\n1,2,3\n');
    expect(parsed.rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parsed.truncated).toBe(false);
  });

  it('handles quoted commas, escaped quotes, and CRLF', () => {
    const parsed = parseDelimited('"x, y","q""q"\r\n1,2\r\n');
    expect(parsed.rows).toEqual([
      ['x, y', 'q"q'],
      ['1', '2'],
    ]);
  });

  it('keeps newlines inside quoted fields', () => {
    const parsed = parseDelimited('a,"line1\nline2",c\n');
    expect(parsed.rows).toEqual([['a', 'line1\nline2', 'c']]);
  });

  it('flushes a final row without trailing newline', () => {
    const parsed = parseDelimited('a,b');
    expect(parsed.rows).toEqual([['a', 'b']]);
  });

  it('returns zero rows for empty input', () => {
    expect(parseDelimited('').rows).toEqual([]);
  });

  it('flags truncation past the char cap', () => {
    const parsed = parseDelimited('a,b,c', ',', { maxChars: 2 });
    expect(parsed.truncated).toBe(true);
  });

  it('supports tab delimiters', () => {
    const parsed = parseDelimited('a\tb\n1\t2\n', '\t');
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('delimiterFor', () => {
  it('picks tab for .tsv, comma otherwise', () => {
    expect(delimiterFor('D:/repo/data.tsv')).toBe('\t');
    expect(delimiterFor('D:/repo/data.csv')).toBe(',');
  });
});

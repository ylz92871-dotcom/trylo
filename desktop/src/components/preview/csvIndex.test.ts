import { describe, expect, it } from 'vitest';
import { indexDelimited, delimitedWindow } from './csvIndex';
describe('complete CSV record index', () => {
  it('preserves BOM, quoted multiline cells, escaped quotes, CRLF and empty trailing fields', () => {
    const content = '\ufeffname,note,last\r\n"a","first\r\nsecond ""quoted""",\r\nend,done,ok';
    const indexed = indexDelimited(content, ',');
    expect(indexed.starts).toHaveLength(3);
    expect(indexed.columns).toBe(3);
    expect(delimitedWindow(content, indexed.starts, 1, 1, ',')).toEqual([['a', 'first\r\nsecond "quoted"', '']]);
    expect(delimitedWindow(content, indexed.starts, 2, 1, ',')).toEqual([['end', 'done', 'ok']]);
  });
  it('reaches data after both old row and character limits without parsing all cells', () => {
    const content = ['header,value', ...Array.from({ length: 12_000 }, (_, i) => `${i},${'record-'.repeat(8)}${i}`)].join('\n');
    expect(content.length).toBeGreaterThan(512 * 1024);
    const indexed = indexDelimited(content, ',');
    expect(indexed.starts).toHaveLength(12_001);
    expect(delimitedWindow(content, indexed.starts, 12_000, 200, ',')[0]?.[0]).toBe('11999');
  });
  it('counts columns beyond the first viewport and handles empty files', () => {
    expect(indexDelimited('', ',')).toEqual({ starts: [], columns: 0 });
    expect(indexDelimited('a\tb\n1\t2\t3\t4\n', '\t').columns).toBe(4);
  });
});

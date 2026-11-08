import { parseDelimited } from './csvParse';

/** Index record boundaries without materializing every cell. Quotes can span
 * physical lines, so splitting on newlines would corrupt real CSV exports. */
export function indexDelimited(content: string, delimiter: ',' | '\t'): { readonly starts: readonly number[]; readonly columns: number } {
  const first = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (content.length === first) return { starts: [], columns: 0 };
  const starts = [first];
  let quoted = false;
  let fields = 1;
  let columns = 1;
  for (let i = first; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '"') {
      if (quoted && content[i + 1] === '"') i += 1;
      else quoted = !quoted;
    } else if (!quoted && ch === delimiter) { fields += 1; columns = Math.max(columns, fields); }
    else if (!quoted && (ch === '\r' || ch === '\n')) {
      if (ch === '\r' && content[i + 1] === '\n') i += 1;
      if (i + 1 < content.length) starts.push(i + 1);
      fields = 1;
    }
  }
  return { starts, columns };
}

export function delimitedWindow(content: string, starts: readonly number[], start: number, count: number, delimiter: ',' | '\t'): readonly (readonly string[])[] {
  if (start < 0 || start >= starts.length || count <= 0) return [];
  return parseDelimited(content.slice(starts[start], starts[start + count] ?? content.length), delimiter, { maxChars: Infinity, maxRows: Infinity }).rows;
}

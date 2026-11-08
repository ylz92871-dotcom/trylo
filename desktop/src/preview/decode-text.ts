/** Modern UTF-8 plus BOM-marked UTF-16 and legacy Chinese exports. Fatal
 * decoding prevents silently replacing an entire report with U+FFFD glyphs. */
export function decodePreviewText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    try { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
    catch { throw new Error('无法识别此文件的文字编码，请使用外部应用打开。'); }
  }
}

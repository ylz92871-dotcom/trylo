import type JSZip from 'jszip';
import type { ArchiveEntry, ArchiveContents } from './archive-types';
export interface ZipEntry extends ArchiveEntry { compressedSize: number; method: number }
export interface ZipPreview extends ArchiveContents { entries: readonly ZipEntry[] }
const MAX_ENTRY = 10 * 1024 * 1024;
function decodeName(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gb18030').decode(bytes); }
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Preflight directory metadata before JSZip allocates its entry objects.
 * No archive entry is extracted to the filesystem or treated as a host path. */
export function inspectZip(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length > 100 * 1024 * 1024 || bytes.length < 22) throw new Error('ZIP 无效或超过 100 MB 预览限制');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let footer = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { footer = offset; break; }
  }
  if (footer < 0) throw new Error('ZIP 目录不完整或文件已损坏');
  const count = view.getUint16(footer + 10, true); const size = view.getUint32(footer + 12, true); let cursor = view.getUint32(footer + 16, true);
  if (view.getUint16(footer + 4, true) || view.getUint16(footer + 6, true) || view.getUint16(footer + 8, true) !== count || count === 65535 || size === 0xffffffff || cursor === 0xffffffff) throw new Error('此预览暂不读取分卷或 ZIP64 归档，请使用外部应用');
  if (count > 10000 || size > 8 * 1024 * 1024 || cursor + size > footer) throw new Error('ZIP 目录超过 10,000 项 / 8 MB 限制或目录位置无效');
  const end = cursor + size; const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('ZIP 文件目录已损坏');
    const nameLength = view.getUint16(cursor + 28, true); const extraLength = view.getUint16(cursor + 30, true); const commentLength = view.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw new Error('ZIP 目录条目不完整');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength); let name = decodeName(rawName);
    const extraEnd = cursor + 46 + nameLength + extraLength;
    for (let extra = cursor + 46 + nameLength; extra + 4 <= extraEnd;) {
      const kind = view.getUint16(extra, true); const length = view.getUint16(extra + 2, true); const value = extra + 4;
      if (value + length > extraEnd) throw new Error('ZIP 附加信息不完整');
      if (kind === 0x7075 && length >= 5 && bytes[value] === 1 && view.getUint32(value + 1, true) === crc32(rawName)) name = new TextDecoder().decode(bytes.subarray(value + 5, value + length));
      extra = value + length;
    }
    const unixType = (view.getUint16(cursor + 4, true) >>> 8) === 3 ? (view.getUint32(cursor + 38, true) >>> 16) & 0xf000 : 0;
    entries.push({ id: index, name, size: view.getUint32(cursor + 24, true), compressedSize: view.getUint32(cursor + 20, true), directory: name.endsWith('/') || unixType === 0x4000, encrypted: !!(view.getUint16(cursor + 8, true) & 1), method: view.getUint16(cursor + 10, true), readable: unixType === 0 || unixType === 0x8000 });
    cursor = next;
  }
  if (cursor !== end) throw new Error('ZIP 目录大小不一致'); return entries;
}
// Public JSZip 3.x API, omitted by its bundled JSZipObject declaration:
// https://stuk.github.io/jszip/documentation/api_zipobject/internal_stream.html
interface StreamingZipEntry extends JSZip.JSZipObject { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> }
async function readEntry(entry: JSZip.JSZipObject, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (typeof (entry as StreamingZipEntry).internalStream !== 'function') throw new Error('ZIP 流式阅读接口不可用');
  return new Promise((resolve, reject) => {
    const stream = (entry as StreamingZipEntry).internalStream('uint8array'); const parts: Uint8Array[] = []; let size = 0; let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); stream.pause();
      if (error) reject(error);
      else { const result = new Uint8Array(size); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } resolve(result); }
    };
    const abort = () => finish(new DOMException('归档条目预览已取消', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('归档条目解压超时')), 5000);
    signal.addEventListener('abort', abort, { once: true });
    stream.on('data', (part: Uint8Array) => { if (settled) return; size += part.length; if (size > MAX_ENTRY) { finish(new Error('此条目解压后超过 10 MB 阅读限制')); return; } parts.push(part); });
    stream.on('error', finish); stream.on('end', () => finish());
    if (signal.aborted) abort(); else stream.resume();
  });
}
export async function loadZipPreview(bytes: Uint8Array, signal: AbortSignal): Promise<ZipPreview> {
  const entries = inspectZip(bytes); signal.throwIfAborted();
  let contents: Promise<JSZip.JSZipObject[]> | undefined;
  const files = (): Promise<JSZip.JSZipObject[]> => contents ??= import('jszip').then(async ({ default: JSZip }) => {
    const zip = await JSZip.loadAsync(bytes, { decodeFileName: (value) => decodeName(value instanceof Uint8Array ? value : Uint8Array.from(value, (part) => typeof part === 'number' ? part : part.charCodeAt(0))), createFolders: false });
    return Object.values(zip.files);
  }).catch(() => { throw new Error('此归档的压缩方式、加密或文件结构暂不支持直接阅读，请使用外部应用'); });
  return { entries, read: async (id, abort) => {
    abort.throwIfAborted();
    const selected = entries[id]; if (!selected || selected.directory) throw new Error('请选择归档中的文件');
    if (selected.readable === false) throw new Error('归档预览不读取链接或特殊条目');
    if (selected.encrypted) throw new Error('此条目已加密，请使用外部应用');
    if (![0, 8].includes(selected.method)) throw new Error('此 ZIP 压缩方式暂不支持预览');
    if (selected.size > MAX_ENTRY) throw new Error('此条目解压后超过 10 MB 阅读限制');
    const matches = (await files()).filter((entry) => (entry.unsafeOriginalName ?? entry.name) === selected.name);
    if (matches.length !== 1 || entries.filter((entry) => entry.name === selected.name).length !== 1) throw new Error('此条目名称重复或无法可靠定位');
    return readEntry(matches[0]!, abort);
  } };
}

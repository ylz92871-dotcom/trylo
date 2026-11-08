/* Byte-only libarchive; compiled 256 MiB ceiling, owner-enforced 8s deadline.
 * No host paths, extraction, scripts, subprocesses or app IPC. */
const MAX_INPUT = 100 * 1024 * 1024, MAX_ENTRY = 10 * 1024 * 1024;
self.onmessage = async ({ data: { action, buffer, name, id, codecs } }) => {
  let module, archive = 0, input = 0, header = 0, chunk = 0;
  try {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_INPUT || !['list', 'read'].includes(action) || (action === 'read' && (!Number.isInteger(id) || id < 0 || id >= 10000))) throw new Error('归档预览请求无效');
    importScripts(codecs.archive);
    const response = await fetch(codecs.archiveWasm);
    if (!response.ok) throw new Error('归档解码器资源缺失，请修复 Trylo 安装');
    const wasm = await response.arrayBuffer();
    if (wasm.byteLength > 8 * 1024 * 1024) throw new Error('归档解码器大小异常');
    module = await self.TryloArchive({ wasmBinary: wasm, locateFile: () => codecs.archiveWasm, print: () => {}, printErr: () => {} });
    const c = (name, args) => module.cwrap(name, 'number', args);
    const alloc = c('malloc', ['number']);
    if (!c('trylo_locale_init', [])()) throw new Error('归档字符编码初始化失败');
    const text = (pointer, max = 4096) => {
      if (!pointer) return '';
      const heap = module.HEAPU8; let end = pointer;
      const limit = Math.min(heap.length, pointer + max);
      while (end < limit && heap[end]) end++;
      if (end === limit) throw new Error('归档路径或错误信息超过限制');
      const bytes = heap.subarray(pointer, end);
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { return new TextDecoder('gb18030').decode(bytes); }
    };
    archive = c('archive_read_new', [])();
    if (!archive) throw new Error('归档解码器内存不足');
    const diagnostic = () => text(c('archive_error_string', ['number'])(archive));
    const formats = ['archive_read_support_filter_all', 'archive_read_support_format_all'];
    // Raw mode is for a single compressed stream. Enabling it for RAR/7z
    // would turn a corrupt archive into a misleading one-entry directory.
    const signature = new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength));
    if ((signature[0] === 31 && signature[1] === 139) || (signature[0] === 66 && signature[1] === 90 && signature[2] === 104) || (signature[0] === 253 && signature[1] === 55 && signature[2] === 122) || (signature[0] === 40 && signature[1] === 181 && signature[2] === 47 && signature[3] === 253) || /\.lzma$/i.test(name)) formats.push('archive_read_support_format_raw');
    for (const fn of formats) if (c(fn, ['number'])(archive) < 0) throw new Error(diagnostic() || '归档格式初始化失败');
    input = alloc(buffer.byteLength || 1); header = alloc(4); chunk = alloc(65536);
    if (!input || !header || !chunk) throw new Error('归档超过解码内存预算');
    module.HEAPU8.set(new Uint8Array(buffer), input);
    if (c('archive_read_open_memory', ['number','number','number'])(archive, input, buffer.byteLength) < 0) throw new Error(diagnostic() || '归档损坏或格式不支持');
    const next = c('archive_read_next_header', ['number','number']);
    const data = c('archive_read_data', ['number','number','number']);
    const skip = c('archive_read_data_skip', ['number']);
    const entries = []; let nameBytes = 0;
    for (let index = 0; ; index++) {
      const status = next(archive, header);
      if (status === 1) break;
      if (status !== 0) throw new Error(diagnostic() || '归档目录不完整或编码不支持');
      if (index >= 10000) throw new Error('归档目录超过 10,000 项限制');
      const pointer = module.HEAPU32[header >>> 2];
      let pathname = text(c('archive_entry_pathname_utf8', ['number'])(pointer) || c('archive_entry_pathname', ['number'])(pointer));
      if (pathname === 'data' && /\.(gz|gzip|bz2|xz|lzma|zst|zstd)$/i.test(name)) pathname = name.replace(/^.*[/\\]/, '').replace(/\.(gz|gzip|bz2|xz|lzma|zst|zstd)$/i, '') || 'data';
      nameBytes += pathname.length * 2;
      if (nameBytes > 4 * 1024 * 1024) throw new Error('归档路径总量超过预览限制');
      const size = c('trylo_entry_size', ['number'])(pointer);
      const regular = !!c('trylo_entry_regular', ['number'])(pointer);
      const encrypted = c('archive_entry_is_encrypted', ['number'])(pointer) > 0;
      if (action === 'read' && index === id) {
        if (!regular || encrypted) throw new Error('链接、特殊条目或加密内容不能直接预览');
        if (size > MAX_ENTRY) throw new Error('此条目解压后超过 10 MB 阅读限制');
        const parts = []; let total = 0;
        for (;;) {
          const count = data(archive, chunk, 65536);
          if (count < 0) throw new Error(diagnostic() || '归档条目损坏或压缩方式不支持');
          if (count === 0) break;
          total += count;
          if (total > MAX_ENTRY) throw new Error('此条目解压后超过 10 MB 阅读限制');
          parts.push(module.HEAPU8.slice(chunk, chunk + count));
        }
        const result = new Uint8Array(total); let offset = 0;
        for (const part of parts) { result.set(part, offset); offset += part.length; }
        self.postMessage({ ok: true, result: result.buffer }, [result.buffer]); return;
      }
      entries.push({ id: index, name: pathname || `条目 ${index + 1}`, size: Number.isSafeInteger(size) && size >= 0 ? size : -1, directory: c('archive_entry_filetype', ['number'])(pointer) === 0x4000, encrypted, readable: regular });
      if (skip(archive) < 0) throw new Error(diagnostic() || '归档条目无法跳过');
    }
    if (action === 'read') throw new Error('归档条目不存在');
    self.postMessage({ ok: true, result: entries });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    self.postMessage({ ok: false, error: /memory|allocation|enlarge|out of bounds|unreachable|Aborted/i.test(detail) ? '此归档超过解码内存预算或已损坏，请使用外部应用。' : detail });
  }
  finally {
    if (module) {
      if (archive) module.cwrap('archive_read_free', 'number', ['number'])(archive);
      const free = module.cwrap('free', null, ['number']);
      for (const pointer of [input, header, chunk]) if (pointer) free(pointer);
    }
  }
};

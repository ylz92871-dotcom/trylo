// Development counterpart of the native read-only Office converter.
import type { Plugin } from 'vite';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { containedPreviewFile } from './path-scope';
import { OfficeQueue, runOfficeProcess } from './office-process';
import { verifyOfficeRuntime } from '../../scripts/build/shared/preview/office-engine.mjs';
import { allowPreviewRequest } from './request-origin';
import { OfficeExtensionCache } from './office-profile';

const MAX_INPUT = 50 * 1024 * 1024;
const MAX_OUTPUT = 100 * 1024 * 1024;
export function officeFilter(ext: string): string {
  if (/^\.(docx|docm|dotx|dotm|doc|rtf|odt|ott)$/.test(ext)) return 'pdf:writer_pdf_Export';
  if (/^\.(pptx|pptm|potx|potm|ppsx|ppsm|ppt|odp|otp)$/.test(ext)) return 'pdf:impress_pdf_Export';
  if (/^\.(xlsx|xlsm|xls|xlsb|ods)$/.test(ext)) return 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}';
  throw new Error('此格式没有页面转换器');
}
async function converter(): Promise<string> {
  const bundled = process.env.TRYLO_PREVIEW_ENGINE_ROOT ?? fileURLToPath(new URL('../../src-tauri/resources/preview/office', import.meta.url));
  const exists = await fs.stat(bundled).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
  if (exists || process.env.TRYLO_PREVIEW_ENGINE_ROOT) return verifyOfficeRuntime(bundled);
  const candidates = process.platform === 'win32'
    ? [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((p) => path.join(p!, 'LibreOffice/program/soffice.com'))
    : ['/usr/bin/libreoffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'];
  for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch { /* Development-only installed fallback. */ } }
  throw new Error('页面预览引擎未准备，请运行 preview 引擎准备脚本');
}

/** Copies a bounded snapshot and never opens the original for writing. */
async function convert(target: string, executable: string, signal: AbortSignal, extensions: OfficeExtensionCache): Promise<Buffer> {
  signal.throwIfAborted();
  const ext = path.extname(target).toLowerCase();
  const filter = officeFilter(ext);
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > MAX_INPUT) throw new Error('页面预览支持 50 MB 以内的 Office 文件');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-office-dev-'));
  try {
    const profile = path.join(temp, 'p');
    await fs.mkdir(path.join(profile, 'user'), { recursive: true });
    await fs.writeFile(path.join(profile, 'user/registrymodifications.xcu'), '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop></item></oor:items>');
    await extensions.restore(profile);
    const input = path.join(temp, `source${ext}`);
    let copied = 0;
    await pipeline(createReadStream(target), new Transform({ transform(chunk: Buffer, _encoding, callback) {
      copied += chunk.length;
      callback(copied > MAX_INPUT ? new Error('页面预览输入在读取时超过 50 MB') : null, chunk);
    } }), createWriteStream(input, { flags: 'wx' }), { signal });
    const env: NodeJS.ProcessEnv = { ...process.env, SAL_DISABLE_OPENCL: '1', PYTHONDONTWRITEBYTECODE: '1' };
    const runtime = path.join(path.dirname(path.dirname(executable)), 'System64');
    if (process.platform === 'win32' && await fs.stat(runtime).then((value) => value.isDirectory(), () => false)) env.PATH = `${runtime}${path.delimiter}${env.PATH ?? ''}`;
    await runOfficeProcess(executable, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', filter, '--outdir', temp, input], { cwd: temp, env, stdio: 'ignore' }, signal);
    signal.throwIfAborted();
    const output = await fs.open(path.join(temp, 'source.pdf'), 'r').catch(() => { throw new Error('未生成预览，文件可能已加密或不受支持'); });
    try {
      if ((await output.stat()).size > MAX_OUTPUT) throw new Error('生成的预览超过 100 MB');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of output.createReadStream({ autoClose: false })) {
        signal.throwIfAborted(); size += chunk.length;
        if (size > MAX_OUTPUT) throw new Error('生成的预览超过 100 MB');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, size);
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('转换器未返回有效 PDF');
      await extensions.capture(profile, signal);
      signal.throwIfAborted();
      return bytes;
    } finally { await output.close(); }
  } finally {
    // mkdtemp owns this exact path, always underneath the selected temp root.
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export function officePreview(): Plugin {
  const queue = new OfficeQueue();
  const extensions = new OfficeExtensionCache();
  let ready: Promise<string> | undefined;
  return { name: 'trylo:office-preview', closeBundle: () => queue.close(), configureServer(server) {
    server.httpServer?.once('close', () => { void queue.close(); });
    server.middlewares.use('/__dev_preview/office', async (req, res) => {
      const abort = new AbortController();
      const cancel = (): void => { if (!res.writableEnded) abort.abort(); };
      req.once('aborted', cancel); res.once('close', cancel);
      try {
        if (req.method !== 'POST' || !allowPreviewRequest(req)) { res.statusCode = 403; res.end('不允许此请求'); return; }
        let body = '';
        for await (const part of req) { body += part; if (body.length > 8192) throw new Error('请求过大'); }
        const { filePath, allowedRoot } = JSON.parse(body) as { filePath: string; allowedRoot: string };
        const target = await containedPreviewFile(filePath, allowedRoot);
        officeFilter(path.extname(target).toLowerCase());
        const bytes = await queue.run(abort.signal, async (signal) => {
          ready ??= converter();
          const executable = await ready;
          signal.throwIfAborted();
          return convert(target, executable, signal, extensions);
        });
        if (!abort.signal.aborted) { res.setHeader('Content-Type', 'application/pdf'); res.end(bytes); }
      } catch (error) {
        if (!abort.signal.aborted && !res.destroyed) { res.statusCode = 422; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(error instanceof Error ? error.message : String(error)); }
      } finally { req.off('aborted', cancel); res.off('close', cancel); }
    });
  } };
}

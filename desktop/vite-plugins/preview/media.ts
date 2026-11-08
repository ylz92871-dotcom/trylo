import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import type { ViteDevServer } from 'vite';
import { containedPreviewFile } from './path-scope';
import { allowPreviewRequest } from './request-origin';
import { mediaFormatFor } from '../../src/preview/media-formats';

export function mediaRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new Error('Invalid range');
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) throw new Error('Invalid range');
  return { start, end };
}

/** Development parity for native Tauri's ranged asset protocol. Tokens grant
 * one validated media file, expire, and are released when the viewer closes. */
export function registerPreviewMedia(server: ViteDevServer): void {
  const sessions = new Map<string, { path: string; size: number; modifiedMs: number; type: string; expires: number }>();
  server.httpServer?.once('close', () => sessions.clear());
  server.middlewares.use('/__dev_preview/media', async (req, res) => {
    try {
      for (const [token, session] of sessions) if (session.expires < Date.now()) sessions.delete(token);
      if (!allowPreviewRequest(req)) { res.statusCode = 403; res.end(); return; }
      const token = (req.url ?? '').replace(/^\//, '').split('?')[0]!;
      if (req.method === 'POST' && !token) {
        let body = '';
        for await (const part of req) { body += part; if (body.length > 8192) throw new Error('请求过大'); }
        const { filePath, allowedRoot } = JSON.parse(body) as { filePath: string; allowedRoot: string };
        const target = await containedPreviewFile(filePath, allowedRoot);
        const type = mediaFormatFor(target)?.mime ?? 'application/octet-stream';
        const stat = await fs.stat(target);
        if (!stat.isFile()) throw new Error('媒体路径不是文件');
        while (sessions.size >= 32) sessions.delete(sessions.keys().next().value!);
        const id = randomUUID();
        sessions.set(id, { path: target, size: stat.size, modifiedMs: stat.mtimeMs, type, expires: Date.now() + 60 * 60_000 });
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ token: id })); return;
      }
      const session = sessions.get(token);
      if (!session) { res.statusCode = 404; res.end('媒体预览已关闭，请重新打开'); return; }
      if (req.method === 'DELETE') { sessions.delete(token); res.statusCode = 204; res.end(); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
      const stat = await fs.stat(session.path);
      if (stat.size !== session.size || stat.mtimeMs !== session.modifiedMs) { res.statusCode = 409; res.end('文件已更新，请重新加载预览'); return; }
      let range;
      try { range = mediaRange(req.headers.range, session.size); }
      catch { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${session.size}`); res.end(); return; }
      res.setHeader('Content-Type', session.type); res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', range ? range.end - range.start + 1 : session.size);
      if (range) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${session.size}`); }
      if (req.method === 'HEAD' || !session.size) { res.end(); return; }
      const stream = createReadStream(session.path, range ?? undefined);
      res.once('close', () => stream.destroy()); stream.once('error', () => res.destroy()); stream.pipe(res);
    } catch (error) { if (!res.headersSent) { res.statusCode = 422; res.end(error instanceof Error ? error.message : String(error)); } else res.destroy(); }
  });
}

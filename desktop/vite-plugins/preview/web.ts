import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import { containedPreviewFile } from './path-scope';
import policy from '../../src/preview/providers/web-policy.json';
import { allowPreviewRequest } from './request-origin';

type WebSession = { token: string; url: string; server: ReturnType<typeof createServer>; warnings: string[]; expires: number };

/** Development uses a separate loopback origin with an unpredictable hostname.
 * Root-relative assets work; a guessed port cannot grant access to the folder. */
export async function openWebSession(filePath: string, allowedRoot: string): Promise<WebSession> {
  const target = await containedPreviewFile(filePath, allowedRoot);
  if (!/\.html?$/i.test(target)) throw new Error('此文件不是 HTML 网页');
  const root = path.dirname(target), entry = path.basename(target), token = randomUUID();
  const warnings: string[] = [];
  const loaded = new Set<string>(); let total = 0;
  let authority = '';
  const server = createServer(async (req, res) => {
    if (req.headers.host?.toLowerCase() !== authority) { res.statusCode = 403; res.end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
    let relative = '';
    try {
      relative = decodeURIComponent((req.url ?? '').split('?')[0]!).replace(/^\/+/, '') || entry;
      if (relative.split(/[\\/]/).some((part) => part.startsWith('.') || !part) || /[\u0000-\u001f]/.test(relative)) throw new Error('资源路径超出网页文件夹');
      let file: string;
      try { file = await containedPreviewFile(path.join(root, relative), root); }
      catch (error) {
        if (!path.extname(relative) && req.headers.accept?.includes('text/html')) file = target;
        else throw error;
      }
      const mime = (policy.mime as Record<string, string>)[path.extname(file).slice(1).toLowerCase()];
      if (!mime) throw new Error('此资源类型不在网页预览范围内');
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > policy.maxResourceBytes) throw new Error('网页资源超过 20 MB 限制');
      if (!loaded.has(file)) {
        if (loaded.size >= policy.maxAssets || total + stat.size > policy.maxTotalBytes) throw new Error('网页资源超过 512 项 / 100 MB 限制');
        loaded.add(file); total += stat.size;
      }
      res.setHeader('Content-Type', mime); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Security-Policy', policy.csp); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Length', stat.size);
      if (req.method === 'HEAD') { res.end(); return; }
      if (stat.size === 0) { res.end(); return; }
      const stream = createReadStream(file, { start: 0, end: stat.size - 1 }); res.once('close', () => stream.destroy()); stream.once('error', () => res.destroy()); stream.pipe(res);
    } catch (error) {
      const message = `${relative}: ${error instanceof Error ? error.message : String(error)}`;
      if (warnings.length < 10 && !warnings.includes(message)) warnings.push(message);
      res.statusCode = 404; res.end('网页资源不可用');
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('网页预览服务未启动'); }
  authority = `${token}.localhost:${address.port}`;
  return { token, url: `http://${authority}/${encodeURIComponent(entry)}`, server, warnings, expires: Date.now() + 60 * 60_000 };
}

export function registerWebPreview(server: ViteDevServer): void {
  const sessions = new Map<string, WebSession>();
  const close = (token: string): void => { const session = sessions.get(token); if (session) { session.server.closeAllConnections(); session.server.close(); sessions.delete(token); } };
  const timer = setInterval(() => { for (const [token, session] of sessions) if (session.expires < Date.now()) close(token); }, 30_000); timer.unref();
  server.httpServer?.once('close', () => { clearInterval(timer); for (const token of sessions.keys()) close(token); });
  server.middlewares.use('/__dev_preview/web', async (req, res) => {
    try {
      if (!allowPreviewRequest(req)) { res.statusCode = 403; res.end(); return; }
      const token = (req.url ?? '').replace(/^\//, '').split('?')[0]!;
      if (req.method === 'POST' && !token) {
        if (sessions.size >= 32) throw new Error('打开的网页预览过多');
        let body = ''; for await (const part of req) { body += part; if (body.length > 8192) throw new Error('请求过大'); }
        const { filePath, allowedRoot } = JSON.parse(body) as { filePath: string; allowedRoot: string };
        const session = await openWebSession(filePath, allowedRoot); sessions.set(session.token, session);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ token: session.token, url: session.url })); return;
      }
      const session = sessions.get(token);
      if (!session) { res.statusCode = 404; res.end('网页预览已关闭'); return; }
      if (req.method === 'DELETE') { close(token); res.statusCode = 204; res.end(); return; }
      if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(session.warnings));
    } catch (error) { res.statusCode = 422; res.end(error instanceof Error ? error.message : String(error)); }
  });
}
